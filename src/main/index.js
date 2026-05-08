/**
 * Electron main process: system tray, hidden scrape windows, stats window, IPC handlers.
 * @see docs/ARCHITECTURE.md
 */

const {
  app,
  Tray,
  Menu,
  BrowserWindow,
  screen,
  ipcMain,
  shell,
} = require("electron");
const path = require("path");
const { pathToFileURL } = require("node:url");
const { parseSpendingSnapshot } = require("./lib/parse-spending.js");
const { computeBillingWindow } = require("./lib/billing-period.js");
const { appendUsageSnapshot, historyForPeriod } = require("./lib/usage-history.js");
const {
  fetchAuthMe,
  probeUsageApis,
  fetchCurrentPeriodUsage,
  fetchAggregatedUsageEvents,
} = require("./lib/cursor-session.js");
const { buildPricingUsageAugmentation, buildUsageError } = require("./lib/model-usage-match.js");
const {
  resolveModelPricing,
  getPricingSnapshotSync,
  removeLegacyDiskCacheFile,
} = require("./lib/model-pricing-fetch.js");
const { extractBillingPies } = require("./lib/parse-billing-breakdown.js");
const { buildUsageEventSeriesForChart } = require("./lib/usage-events-aggregate.js");
const { checkForAppUpdate } = require("./lib/app-update-check.js");

const CURSOR_PARTITION = "persist:cursor-widget";
const SPENDING_URL = "https://cursor.com/dashboard/spending";
const BILLING_URL = "https://cursor.com/dashboard/billing";
const APP_TITLE = "Cursor stats";

let tray = null;
let statsWindow = null;
let loginWindow = null;
let lastStats = null;
let lastSession = null;
/** @type {{ auto: number[] | null, api: number[] | null } | null} */
let lastUsageSeries = null;
/** @type {Record<string, unknown> | null} */
let lastUsageEventMeta = null;
/** @type {Record<string, unknown> | null} Aggregated spend by pricing row from get-aggregated-usage-events. */
let lastAggregatedUsage = null;
let trayImageFromStats = null;
/** Throttle periodic refreshes for both tray-only and visible dashboard states. */
let lastStatsRefreshStartedAt = 0;
const STATS_REFRESH_INTERVAL_MS = 30000;
const STATS_POLL_TICK_MS = 1000;
const TRAY_UPDATE_SPIN_MS = 650;
const TRAY_UPDATE_SPIN_FRAME_MS = 50;
/** Keep `/api/auth/me` bounded so the UI is not blocked by a hung request. */
const AUTH_ME_TIMEOUT_MS = 12000;
let refreshStatsInFlight = null;
let trayUpdateSpinTimer = null;
let trayUpdateSpinStartedAt = 0;

/**
 * Apply `/api/auth/me` as soon as it returns so the dashboard can show the user before spending/billing scrapes finish.
 * Preserves any existing session extras (e.g. pies from a prior refresh).
 */
function applyEarlySessionFromMe(me) {
  if (!me || !me.ok || !me.user) return;
  const prev = lastSession && typeof lastSession === "object" ? lastSession : null;
  lastSession = {
    me,
    accountAvatarUrl: prev && prev.accountAvatarUrl != null ? prev.accountAvatarUrl : null,
    probes: prev && prev.probes != null ? prev.probes : null,
    billingPies: prev && prev.billingPies != null ? prev.billingPies : null,
    billingMeta: prev && prev.billingMeta != null ? prev.billingMeta : null,
    billingError: prev && prev.billingError != null ? prev.billingError : null,
    usageEvents: prev && prev.usageEvents != null ? prev.usageEvents : null,
    currentPeriodUsage:
      prev && prev.currentPeriodUsage != null ? prev.currentPeriodUsage : null,
    fromAuthApiOnly: !(prev && prev.probes != null),
  };
  if (statsWindow && !statsWindow.isDestroyed()) {
    statsWindow.webContents.send("cursor:session", lastSession);
  }
}

async function warmAuthSession() {
  try {
    const me = await fetchAuthMe(CURSOR_PARTITION, { timeoutMs: AUTH_ME_TIMEOUT_MS });
    applyEarlySessionFromMe(me);
  } catch (e) {
    console.error("warmAuthSession:", e);
  }
}

function positionStatsWindow() {
  if (!statsWindow || !tray) return;
  const bounds = tray.getBounds();
  const winBounds = statsWindow.getBounds();
  const display = screen.getDisplayNearestPoint({ x: bounds.x, y: bounds.y });
  const { x: dx, y: dy, width: dw, height: dh } = display.workArea;

  let x = Math.round(bounds.x + bounds.width / 2 - winBounds.width / 2);
  let y = Math.round(bounds.y - winBounds.height);

  if (process.platform === "darwin") {
    y = Math.round(bounds.y + bounds.height);
  } else if (bounds.y < dy + dh / 2) {
    y = Math.round(bounds.y + bounds.height);
  }

  x = Math.min(Math.max(x, dx + 8), dx + dw - winBounds.width - 8);
  y = Math.min(Math.max(y, dy + 8), dy + dh - winBounds.height - 8);

  statsWindow.setPosition(x, y);
}

function updateTrayIcon(stats) {
  if (!tray || !trayImageFromStats) return;
  try {
    const rotation =
      trayUpdateSpinStartedAt > 0
        ? Math.min(1, (Date.now() - trayUpdateSpinStartedAt) / TRAY_UPDATE_SPIN_MS)
        : 0;
    tray.setImage(trayImageFromStats(addTrayCycleStats(stats), { rotation }));
  } catch (err) {
    console.error("Tray icon update failed:", err);
  }
}

function addTrayCycleStats(stats) {
  if (!stats || stats.ok === false) return stats;
  const billing = computeBillingWindow(stats);
  if (!billing || !(billing.periodStart instanceof Date) || !(billing.periodEnd instanceof Date)) {
    return stats;
  }
  const startMs = billing.periodStart.getTime();
  const endMs = billing.periodEnd.getTime();
  const spanMs = endMs - startMs;
  if (!Number.isFinite(spanMs) || spanMs <= 0) return stats;
  const elapsedMs = Math.max(0, Math.min(spanMs, Date.now() - startMs));
  return {
    ...stats,
    cyclePercent: Math.round((elapsedMs / spanMs) * 100),
  };
}

function spinTrayAfterUpdate() {
  if (trayUpdateSpinTimer) {
    clearInterval(trayUpdateSpinTimer);
  }
  trayUpdateSpinStartedAt = Date.now();
  trayUpdateSpinTimer = setInterval(() => {
    if (Date.now() - trayUpdateSpinStartedAt >= TRAY_UPDATE_SPIN_MS) {
      clearInterval(trayUpdateSpinTimer);
      trayUpdateSpinTimer = null;
      trayUpdateSpinStartedAt = 0;
      updateTrayIcon(lastStats);
      return;
    }
    updateTrayIcon(lastStats);
  }, TRAY_UPDATE_SPIN_FRAME_MS);
  updateTrayIcon(lastStats);
}

function getChartPayload() {
  const billing =
    lastStats && lastStats.ok !== false ? computeBillingWindow(lastStats) : null;
  const userData = app.getPath("userData");
  const history = billing ? historyForPeriod(userData, billing.periodEndKey) : [];
  return {
    billing,
    history,
    stats: lastStats,
    session: lastSession,
    usageSeries: lastUsageSeries,
    usageEventMeta: lastUsageEventMeta,
    aggregatedUsage: lastAggregatedUsage,
  };
}

function updateTrayTooltipFromStats(stats) {
  if (!tray || !stats) return;
  const lines = [APP_TITLE];
  if (stats.autoPercent != null) {
    lines.push(`Cursor allowance: ${stats.autoPercent}%`);
  }
  if (stats.apiPercent != null) {
    lines.push(`API allowance: ${stats.apiPercent}%`);
  }
  const billing = stats.ok !== false ? computeBillingWindow(stats) : null;
  if (billing) {
    const cycleStats = addTrayCycleStats(stats);
    const cycleText =
      cycleStats && cycleStats.cyclePercent != null
        ? `${cycleStats.cyclePercent}% of cycle`
        : `day ${billing.currentDayIndex + 1}/${billing.daysTotal}`;
    lines.push(`Billing cycle: ${cycleText} \u2192 ${billing.periodEndLabel}`);
  } else if (stats.resetLabel) {
    lines.push(`Resets ${stats.resetLabel}`);
  }
  tray.setToolTip(lines.join("\n"));
}

/**
 * next/app embeds the serialized page in #__NEXT_DATA__ as soon as HTML arrives — often
 * before innerText shows "% Auto" etc. Relying only on body text heuristics could spin for
 * tens of seconds (e.g. 6k–8k chars of shell copy without a regex match). Browsers look
 * "instant" because the network is; our old loop was the bottleneck.
 * @param {"spending" | "billing"} page
 * @param {number} [maxMs]
 * @returns {Promise<boolean>} true when the frame looks ready, or on timeout (scrape may still work).
 */
async function waitForNextDashboardPage(win, page, maxMs = 12000) {
  const intervalMs = 100;
  const deadline = Date.now() + maxMs;
  const snapScript = `(() => {
    const t = (document.title || "").toLowerCase();
    if (t.includes("just a moment") || t.includes("attention required")) {
      return { cf: true };
    }
    const el = document.getElementById("__NEXT_DATA__");
    let hasNext = false;
    if (el && el.textContent && el.textContent.length > 2) {
      try {
        const p = JSON.parse(el.textContent);
        hasNext = p != null && typeof p === "object";
      } catch (_e) {
        hasNext = false;
      }
    }
    const text = document.body ? document.body.innerText : "";
    return {
      hasNext,
      len: text.length,
      hasUsage:
        /%\\s*auto|resets?\\s*on|Auto\\+Composer|Usage\\s*summary|Usage-based/i.test(text),
      hasLogin: /\\bsign\\s*in\\b/i.test(text.slice(0, 5000)),
      hasBilling: /billing|invoice|usage|pool|subscription/i.test(text.slice(0, 10000)),
    };
  })()`;

  while (Date.now() < deadline) {
    const snap = await win.webContents.executeJavaScript(snapScript);
    if (snap && snap.cf) {
      await new Promise((r) => setTimeout(r, 400));
      continue;
    }
    if (snap && snap.hasNext) {
      await new Promise((r) => setTimeout(r, 50));
      return true;
    }
    if (page === "spending") {
      if (snap && (snap.hasUsage || snap.len > 10000)) {
        return true;
      }
      if (snap && snap.hasLogin && snap.len < 20000) {
        return true;
      }
    } else {
      if (snap && snap.len > 2000 && snap.hasBilling) {
        return true;
      }
      if (snap && snap.len > 10000) {
        return true;
      }
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return true;
}

async function scrapeBillingPage() {
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      partition: CURSOR_PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  try {
    await win.loadURL(BILLING_URL);
    await waitForNextDashboardPage(win, "billing");

    return await win.webContents.executeJavaScript(`(() => {
      let nextData = null;
      const el = document.getElementById("__NEXT_DATA__");
      try {
        nextData = el ? JSON.parse(el.textContent) : null;
      } catch (_e) {
        nextData = null;
      }
      const pickAvatar = () => {
        const a = document.querySelector('img[src*="workoscdn.com"]');
        if (a) return a.getAttribute("src") || a.currentSrc || null;
        const b = document.querySelector('img.rounded-full[src^="https://"]');
        if (b) return b.getAttribute("src") || b.currentSrc || null;
        return null;
      };
      return {
        nextData,
        title: document.title || "",
        url: location.href,
        accountAvatarUrl: pickAvatar(),
      };
    })()`);
  } finally {
    if (!win.isDestroyed()) {
      win.destroy();
    }
  }
}

/** When billing __NEXT_DATA__ has no model breakdown, show used vs remaining from spending %s. */
function piesFromSpendingPercents(stats) {
  if (!stats || stats.ok === false) return null;
  if (stats.autoPercent == null && stats.apiPercent == null) return null;
  const auto = Math.max(0, Math.min(100, Number(stats.autoPercent) || 0));
  const api = Math.max(0, Math.min(100, Number(stats.apiPercent) || 0));
  return {
    auto: [
      { label: "Used", value: auto / 100 },
      { label: "Remaining", value: (100 - auto) / 100 },
    ],
    api: [
      { label: "Used", value: api / 100 },
      { label: "Remaining", value: (100 - api) / 100 },
    ],
    candidates: [],
    fromSpendingSummary: true,
  };
}

async function scrapeSpendingPage() {
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      partition: CURSOR_PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  try {
    await win.loadURL(SPENDING_URL);
    await waitForNextDashboardPage(win, "spending");

    const snapshot = await win.webContents.executeJavaScript(`(() => {
      let nextData = null;
      const el = document.getElementById("__NEXT_DATA__");
      try {
        nextData = el ? JSON.parse(el.textContent) : null;
      } catch (_e) {
        nextData = null;
      }
      const pickAvatar = () => {
        const a = document.querySelector('img[src*="workoscdn.com"]');
        if (a) return a.getAttribute("src") || a.currentSrc || null;
        const b = document.querySelector('img.rounded-full[src^="https://"]');
        if (b) return b.getAttribute("src") || b.currentSrc || null;
        return null;
      };
      return {
        text: document.body ? document.body.innerText : "",
        nextData,
        title: document.title || "",
        url: location.href,
        accountAvatarUrl: pickAvatar(),
      };
    })()`);

    return parseSpendingSnapshot(snapshot);
  } finally {
    if (!win.isDestroyed()) {
      win.destroy();
    }
  }
}

async function doRefreshStats({ pushToWindow }) {
  const prevStats = lastStats;
  const prevSession = lastSession;
  const prevUsageSeries = lastUsageSeries;
  const prevUsageEventMeta = lastUsageEventMeta;
  const prevAggregatedUsage = lastAggregatedUsage;
  try {
    const mePromise = fetchAuthMe(CURSOR_PARTITION, { timeoutMs: AUTH_ME_TIMEOUT_MS });
    mePromise
      .then((me) => applyEarlySessionFromMe(me))
      .catch((err) => console.error("auth/me (early):", err));
    const [scrape, me] = await Promise.all([scrapeSpendingPage(), mePromise]);
    let stats = scrape;
    if (me && me.ok && me.user && stats.loggedIn !== true) {
      stats = {
        ...stats,
        loggedIn: true,
        note: stats.loggedIn === false ? null : stats.note,
      };
    }
    lastStats = stats;
    updateTrayTooltipFromStats(stats);
    updateTrayIcon(stats);
    const billing = computeBillingWindow(stats);
    if (billing && stats.loggedIn === true) {
      appendUsageSnapshot(app.getPath("userData"), stats, billing);
    }

    if (stats.loggedIn === true) {
      const startMs = billing?.periodStart ? new Date(billing.periodStart).getTime() : 0;
      const [probes, billResult, periodUsage, aggregatedRes, prResolved] = await Promise.all([
        probeUsageApis(CURSOR_PARTITION),
        scrapeBillingPage().catch((e) => ({
          _error: e instanceof Error ? e.message : String(e),
        })),
        fetchCurrentPeriodUsage(CURSOR_PARTITION).catch((e) => ({
          ok: false,
          amountUsd: null,
          usedUsd: null,
          limitUsd: null,
          remainingUsd: null,
          error: e instanceof Error ? e.message : String(e),
        })),
        billing && startMs > 0
          ? fetchAggregatedUsageEvents(CURSOR_PARTITION, startMs).catch((e) => ({
              ok: false,
              json: null,
              error: e instanceof Error ? e.message : String(e),
            }))
          : Promise.resolve({ ok: false, json: null, error: "no billing window" }),
        resolveModelPricing({ forceRefresh: false }),
      ]);
      const noBilling = {
        ok: false,
        eventCount: 0,
        bucketedCount: 0,
        pages: 0,
        auto: null,
        api: null,
        error: "no billing window",
        meta: null,
      };
      const usageChart = billing
        ? await buildUsageEventSeriesForChart(CURSOR_PARTITION, billing, stats)
        : noBilling;
      if (usageChart) {
        lastUsageEventMeta =
          usageChart.meta && typeof usageChart.meta === "object"
            ? /** @type {Record<string, unknown>} */ (usageChart.meta)
            : null;
      }
      if (usageChart && usageChart.ok && (usageChart.auto != null || usageChart.api != null)) {
        lastUsageSeries = { auto: usageChart.auto, api: usageChart.api };
      } else if (stats.loggedIn !== true) {
        lastUsageSeries = null;
        lastUsageEventMeta = null;
      }
      /* else: keep lastUsageSeries so the chart does not jump back to a blank/straight state */
      const sessionPayload = {
        me,
        accountAvatarUrl:
          (scrape && scrape.accountAvatarUrl) ||
          (billResult && !billResult._error && billResult.accountAvatarUrl) ||
          null,
        probes,
        billingPies: null,
        billingMeta: null,
        billingError: null,
        usageEvents:
          usageChart && typeof usageChart === "object"
            ? {
                ok: Boolean(usageChart.ok),
                eventCount: usageChart.eventCount,
                bucketedCount: usageChart.bucketedCount ?? 0,
                pages: usageChart.pages,
                error: usageChart.error || (usageChart.ok ? null : "unavailable"),
                meta: usageChart.meta && typeof usageChart.meta === "object" ? usageChart.meta : null,
              }
            : null,
      };
      let billingPies = { auto: [], api: [], candidates: [] };
      if (billResult._error) {
        sessionPayload.billingError = billResult._error;
      } else if (billResult && billResult.nextData !== undefined) {
        sessionPayload.billingMeta = { title: billResult.title, url: billResult.url };
        if (billResult.nextData) {
          billingPies = extractBillingPies(billResult.nextData);
        }
      }
      const noSlices =
        (!billingPies.auto || billingPies.auto.length === 0) &&
        (!billingPies.api || billingPies.api.length === 0);
      if (noSlices) {
        const syn = piesFromSpendingPercents(stats);
        if (syn) billingPies = syn;
      }
      sessionPayload.billingPies = billingPies;
      sessionPayload.currentPeriodUsage =
        periodUsage && typeof periodUsage === "object"
          ? {
              ok: Boolean(periodUsage.ok),
              amountUsd:
                periodUsage.amountUsd != null && Number.isFinite(periodUsage.amountUsd)
                  ? periodUsage.amountUsd
                  : null,
              usedUsd:
                periodUsage.usedUsd != null && Number.isFinite(periodUsage.usedUsd)
                  ? periodUsage.usedUsd
                  : null,
              limitUsd:
                periodUsage.limitUsd != null && Number.isFinite(periodUsage.limitUsd)
                  ? periodUsage.limitUsd
                  : null,
              remainingUsd:
                periodUsage.remainingUsd != null && Number.isFinite(periodUsage.remainingUsd)
                  ? periodUsage.remainingUsd
                  : null,
              error: periodUsage.error != null ? String(periodUsage.error) : null,
            }
          : {
              ok: false,
              amountUsd: null,
              usedUsd: null,
              limitUsd: null,
              remainingUsd: null,
              error: null,
            };
      lastSession = sessionPayload;

      let pricingSnap;
      try {
        pricingSnap =
          prResolved.ok && prResolved.data ? prResolved.data : getPricingSnapshotSync();
      } catch (e) {
        pricingSnap = getPricingSnapshotSync();
      }
      if (aggregatedRes && aggregatedRes.ok && aggregatedRes.json) {
        lastAggregatedUsage = buildPricingUsageAugmentation(pricingSnap, aggregatedRes.json, startMs);
      } else {
        const err =
          aggregatedRes && aggregatedRes.error != null
            ? String(aggregatedRes.error)
            : "aggregated usage unavailable";
        lastAggregatedUsage = buildUsageError(pricingSnap, err, startMs);
      }
    } else {
      lastAggregatedUsage = null;
      lastUsageSeries = null;
      lastUsageEventMeta = null;
      if (me && me.ok && me.user) {
        lastSession = {
          me,
          accountAvatarUrl: (scrape && scrape.accountAvatarUrl) || null,
          probes: null,
          billingPies: null,
          billingMeta: null,
          billingError: null,
          usageEvents: null,
          currentPeriodUsage: null,
          fromAuthApiOnly: true,
        };
      } else {
        lastSession = null;
      }
    }

    if (pushToWindow && statsWindow && !statsWindow.isDestroyed()) {
      statsWindow.webContents.send("cursor:stats", stats);
      statsWindow.webContents.send("cursor:chart", getChartPayload());
      statsWindow.webContents.send("cursor:session", lastSession);
    }
    return stats;
  } catch (err) {
    const hadGood =
      prevStats && prevStats.ok !== false && prevStats.loggedIn === true;
    console.error("refreshStats:", err);
    if (hadGood) {
      lastStats = prevStats;
      lastSession = prevSession;
      lastUsageSeries = prevUsageSeries;
      lastUsageEventMeta = prevUsageEventMeta;
      lastAggregatedUsage = prevAggregatedUsage;
      updateTrayIcon(prevStats);
      updateTrayTooltipFromStats(prevStats);
      /* Keep the UI; do not clear or re-send a failed payload. */
      return prevStats;
    }
    const fail = {
      ok: false,
      loggedIn: null,
      resetLabel: null,
      resetRelative: null,
      autoPercent: null,
      apiPercent: null,
      onDemand: null,
      note: err instanceof Error ? err.message : String(err),
      title: "",
      url: "",
    };
    lastStats = fail;
    lastSession = null;
    lastUsageSeries = null;
    lastUsageEventMeta = null;
    lastAggregatedUsage = null;
    updateTrayIcon(null);
    if (pushToWindow && statsWindow && !statsWindow.isDestroyed()) {
      statsWindow.webContents.send("cursor:stats", fail);
      statsWindow.webContents.send("cursor:chart", getChartPayload());
      statsWindow.webContents.send("cursor:session", null);
    }
    return fail;
  }
}

function refreshStats(opts) {
  if (refreshStatsInFlight) {
    return refreshStatsInFlight;
  }
  lastStatsRefreshStartedAt = Date.now();
  refreshStatsInFlight = doRefreshStats(opts).finally(() => {
    refreshStatsInFlight = null;
    spinTrayAfterUpdate();
  });
  return refreshStatsInFlight;
}

function isStatsWindowVisible() {
  return Boolean(statsWindow && !statsWindow.isDestroyed() && statsWindow.isVisible());
}

function openLoginWindow() {
  if (loginWindow && !loginWindow.isDestroyed()) {
    loginWindow.focus();
    return;
  }

  loginWindow = new BrowserWindow({
    width: 520,
    height: 780,
    show: true,
    title: APP_TITLE,
    webPreferences: {
      partition: CURSOR_PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  loginWindow.loadURL(SPENDING_URL);

  loginWindow.on("closed", () => {
    loginWindow = null;
    const push = statsWindow && !statsWindow.isDestroyed();
    if (push) {
      statsWindow.webContents.send("cursor:login-closed");
    }
    // One near-immediate + one later refresh (avoids 4× concurrent long polls).
    for (const ms of [100, 2500]) {
      setTimeout(() => {
        refreshStats({ pushToWindow: Boolean(push) }).catch((err) => {
          console.error("refresh after login:", err);
        });
      }, ms);
    }
  });
}

function toggleStatsWindow() {
  if (statsWindow && !statsWindow.isDestroyed()) {
    if (statsWindow.isVisible()) {
      statsWindow.hide();
    } else {
      positionStatsWindow();
      statsWindow.show();
      statsWindow.focus();
    }
    return;
  }

  const dashboardPath = path.join(__dirname, "..", "renderer", "dashboard.html");
  const dashboardUrl = pathToFileURL(dashboardPath).href;

  statsWindow = new BrowserWindow({
    width: 380,
    height: 640,
    minWidth: 320,
    minHeight: 440,
    show: false,
    frame: true,
    resizable: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    title: APP_TITLE,
    backgroundColor: "#fafafa",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  statsWindow.on("closed", () => {
    statsWindow = null;
  });

  const failShow = setTimeout(() => {
    if (statsWindow && !statsWindow.isDestroyed() && !statsWindow.isVisible()) {
      positionStatsWindow();
      statsWindow.show();
    }
  }, 3000);

  statsWindow.once("ready-to-show", () => {
    clearTimeout(failShow);
    positionStatsWindow();
    statsWindow.show();
  });

  const pendingStats = lastStats;

  statsWindow.webContents.once("did-finish-load", () => {
    statsWindow.setTitle(APP_TITLE);
    if (pendingStats) {
      statsWindow.webContents.send("cursor:stats", pendingStats);
    }
    statsWindow.webContents.send("cursor:chart", getChartPayload());
    statsWindow.webContents.send("cursor:session", lastSession);
  });

  statsWindow.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL) => {
    clearTimeout(failShow);
    console.error("dashboard did-fail-load", errorCode, errorDescription, validatedURL);
    if (statsWindow && !statsWindow.isDestroyed()) {
      statsWindow.show();
      const msg = `Could not load dashboard (code ${errorCode}).\n${String(errorDescription)}`;
      statsWindow.webContents
        .executeJavaScript(
          `(() => { const p = document.createElement("p"); p.style.padding = "16px"; p.style.fontFamily = "system-ui,sans-serif"; p.textContent = ${JSON.stringify(msg)}; document.body.replaceChildren(p); })();`,
        )
        .catch(() => {});
    }
  });

  statsWindow.loadURL(dashboardUrl);

  statsWindow.on("show", () => {
    refreshStats({ pushToWindow: true }).catch((err) => {
      console.error("refresh on show:", err);
    });
  });
}

function buildTrayMenu() {
  return Menu.buildFromTemplate([
    { label: "Show stats", click: () => toggleStatsWindow() },
    { label: "Sign in to Cursor…", click: () => openLoginWindow() },
    {
      label: "Refresh usage",
      click: () => {
        refreshStats({ pushToWindow: true });
      },
    },
    { type: "separator" },
    { label: "Quit", click: () => app.quit() },
  ]);
}

function createTray() {
  if (!trayImageFromStats) return;
  tray = new Tray(trayImageFromStats(null));
  tray.setToolTip(APP_TITLE);
  tray.setContextMenu(buildTrayMenu());

  tray.on("click", () => {
    toggleStatsWindow();
  });
}

app.whenReady().then(() => {
  trayImageFromStats = require("./lib/tray-icon.js").trayImageFromStats;

  app.setName(APP_TITLE);

  if (process.platform === "darwin") {
    app.dock?.hide();
  }

  ipcMain.handle("cursor:sign-in", async () => {
    openLoginWindow();
    return { ok: true };
  });

  ipcMain.handle("cursor:refresh-stats", async () => {
    return refreshStats({ pushToWindow: true });
  });

  ipcMain.handle("cursor:get-pricing", async () => {
    try {
      const prResolved = await resolveModelPricing({ forceRefresh: false });
      if (prResolved.ok && prResolved.data) {
        return {
          ok: true,
          data: prResolved.data,
          meta: prResolved.meta,
        };
      }
      return {
        ok: false,
        error: prResolved.error || "pricing_unavailable",
        meta: prResolved.meta,
      };
    } catch (e) {
      console.error("[model-pricing] cursor:get-pricing IPC error:", e);
      return {
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  });

  ipcMain.handle("cursor:last-stats", async () => lastStats);

  ipcMain.handle("cursor:get-chart-data", async () => getChartPayload());

  ipcMain.handle("cursor:get-session", async () => lastSession);

  ipcMain.handle("cursor:open-external", async (_event, url) => {
    if (typeof url !== "string" || !/^https:\/\//i.test(url)) {
      return { ok: false, error: "Invalid URL" };
    }
    await shell.openExternal(url);
    return { ok: true };
  });

  ipcMain.handle("cursor:check-app-update", async (_event, opts) => {
    const force = opts && typeof opts === "object" && opts.force === true;
    return checkForAppUpdate(app, { force });
  });

  createTray();

  warmAuthSession().catch(() => {});
  removeLegacyDiskCacheFile();

  setInterval(() => {
    if (refreshStatsInFlight) {
      return;
    }
    const now = Date.now();
    if (now - lastStatsRefreshStartedAt < STATS_REFRESH_INTERVAL_MS) {
      return;
    }
    refreshStats({ pushToWindow: isStatsWindowVisible() }).catch((err) => {
      console.error("auto-refresh:", err);
    });
  }, STATS_POLL_TICK_MS);
});

app.on("window-all-closed", () => {
  /* Tray app: keep running */
});

app.on("before-quit", () => {
  if (statsWindow && !statsWindow.isDestroyed()) {
    statsWindow.destroy();
    statsWindow = null;
  }
  if (loginWindow && !loginWindow.isDestroyed()) {
    loginWindow.destroy();
    loginWindow = null;
  }
});
