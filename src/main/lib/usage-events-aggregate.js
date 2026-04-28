/**
 * Fetches and aggregates Cursor dashboard usage events for the billing line chart.
 * @see https://cursor.com/api/dashboard/get-filtered-usage-events
 * @see docs/ARCHITECTURE.md
 */

const { fetchFilteredUsageEventsViaRendererWindow } = require("./cursor-session.js");
const { extractEventsArray } = require("./usage-event-extract.js");

const USAGE_EVENTS_URL = "https://cursor.com/api/dashboard/get-filtered-usage-events";

const MAX_PAGES = 50;
/** Matches the dashboard usage page default batch size. */
const DEFAULT_PAGE_SIZE = 100;
/** Single HTTP call limit — avoids blocking refresh when the server never responds. */
const USAGE_HTTP_TIMEOUT_MS = 20000;

/**
 * YYYY-MM-DD in local time (matches usage dashboard query params).
 * @param {Date} d
 */
function formatLocalYmd(d) {
  if (!(d instanceof Date) || !Number.isFinite(d.getTime())) return "";
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Same Referer shape as the browser on https://cursor.com/dashboard/usage (Network tab).
 * `periodEnd` is the reset day (exclusive end in the UI), e.g. March usage uses to=April 1.
 * @param {Date} periodStart
 * @param {Date} periodEnd
 */
function formatUsagePageReferer(periodStart, periodEnd) {
  const from = formatLocalYmd(periodStart);
  const to = formatLocalYmd(periodEnd);
  if (!from || !to) return "https://cursor.com/dashboard/usage";
  return `https://cursor.com/dashboard/usage?from=${from}&to=${to}`;
}

/**
 * Day index 0 = first full day slot after `periodStart` (ms), consistent with
 * `billing-period` `currentDayIndex` = floor((now - periodStart) / 86_400_000).
 * Calendar-day rounding can disagree with that around DST; one formula avoids a skewed x-axis.
 * @param {Date} periodStart
 * @param {number} tMs
 * @returns {number}
 */
function dayIndexInBillingPeriod(periodStart, tMs) {
  return Math.floor((tMs - periodStart.getTime()) / 86400000);
}

/**
 * @param {Record<string, unknown>} o
 * @returns {number | null} ms
 */
function getEventTimeMsFromObjectKeys(o) {
  const n = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

  for (const key of [
    "timestamp",
    "ts",
    "time",
    "createdAt",
    "eventTime",
    "at",
    "date",
    "occurredAt",
    "EventTime",
  ]) {
    const t = o[key];
    if (typeof t === "string" && /^\d+$/.test(t)) {
      const b = parseInt(t, 10);
      if (b > 1e12) return b;
      if (b > 1e9) return b * 1000;
    }
    if (typeof t === "string" && t.length > 8 && /^\d{4}-\d{2}/.test(t)) {
      const p = Date.parse(t);
      if (Number.isFinite(p)) return p;
    }
    const num = t != null && typeof t === "number" ? t : n(t);
    if (num != null) {
      if (num > 1e12) return num;
      if (num > 1e9) return num * 1000;
    }
  }
  return null;
}

/**
 * @param {unknown} e
 * @returns {number | null} ms
 */
function getEventTimeMs(e) {
  if (e == null || typeof e !== "object" || Array.isArray(e)) return null;
  const o = /** @type {Record<string, unknown>} */ (e);
  const direct = getEventTimeMsFromObjectKeys(o);
  if (direct != null) return direct;
  for (const key of ["record", "metadata", "event", "usage", "data", "item"]) {
    const nest = o[key];
    if (nest && typeof nest === "object" && !Array.isArray(nest)) {
      const t = getEventTimeMsFromObjectKeys(/** @type {Record<string, unknown>} */ (nest));
      if (t != null) return t;
    }
  }
  return null;
}

/**
 * @param {unknown} v
 * @returns {number}
 */
function toPositiveNumber(v) {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const t = v.trim();
    if (/^\d+(\.\d+)?$/.test(t)) {
      const n = parseFloat(t);
      if (n > 0) return n;
    }
  }
  return 0;
}

/**
 * Sums / extracts cost from `requestsCosts` (number, array, or object).
 * @param {unknown} rc
 * @returns {number}
 */
function weightFromRequestsCosts(rc) {
  if (rc == null) return 0;
  if (typeof rc === "number" && rc > 0) {
    if (rc % 1 !== 0 && rc < 500) return rc * 100;
    if (rc < 50) return rc * 100;
    return rc;
  }
  if (Array.isArray(rc)) {
    let s = 0;
    for (const it of rc) {
      if (it && typeof it === "object" && !Array.isArray(it)) {
        const u = /** @type {Record<string, unknown>} */ (it);
        s +=
          toPositiveNumber(u.cents) ||
          toPositiveNumber(u.totalCents) ||
          toPositiveNumber(u.amountCents) ||
          (() => {
            const a = toPositiveNumber(u.amount);
            return a < 100 ? a * 100 : a;
          })();
      }
    }
    return s;
  }
  if (typeof rc === "object" && !Array.isArray(rc)) {
    const u = /** @type {Record<string, unknown>} */ (rc);
    return toPositiveNumber(u.totalCents) || toPositiveNumber(u.cents) || toPositiveNumber(u.total);
  }
  return 0;
}

/**
 * @param {unknown} e
 * @returns {number}
 */
function getEventWeight(e) {
  if (e == null || typeof e !== "object" || Array.isArray(e)) return 0;
  const o = /** @type {Record<string, unknown>} */ (e);
  const tu = o.tokenUsage;
  if (tu && typeof tu === "object" && !Array.isArray(tu)) {
    const t = /** @type {Record<string, unknown>} */ (tu);
    if (typeof t.totalCents === "string" && t.totalCents) {
      const p = parseFloat(/** @type {string} */ (t.totalCents));
      if (p > 0) return p;
    }
    const tc = toPositiveNumber(t.totalCents);
    if (tc > 0) return tc;
    const inTok = Number(t.inputTokens) || 0;
    const outTok = Number(t.outputTokens) || 0;
    const cr = Number(t.cacheReadTokens) || 0;
    const cw = Number(t.cacheWriteTokens) || 0;
    const w = inTok + outTok + 0.25 * cr + 0.5 * cw;
    if (w > 0) return w;
  }
  const fromRc = weightFromRequestsCosts(o.requestsCosts);
  if (fromRc > 0) return fromRc;
  for (const k of ["totalCents", "cents", "amountCents", "costCents", "requestCostCents", "billedCents", "dollarAmount"]) {
    const c = o[k];
    if (typeof c === "number" && c > 0) return c < 500 ? c * 100 : c;
    if (typeof c === "string" && c) {
      const p = parseFloat(c.replace(/[$,]/g, ""));
      if (p > 0) return p < 500 ? p * 100 : p;
    }
  }
  if (o.model != null || o.kind != null || o.timestamp != null) return 1;
  return 0;
}

/**
 * @param {unknown} e
 * @returns {boolean | "unknown"} true = API pool, false = auto/composer, unknown = not enough signal
 */
function classifyPool(e) {
  if (e == null || typeof e !== "object" || Array.isArray(e)) return "unknown";
  const o = /** @type {Record<string, unknown>} */ (e);
  const parts = [
    o.kind,
    o.type,
    o.category,
    o.billingType,
    o.pool,
    o.usageType,
    o.billing,
    o.subscriptionType,
    o.featureName,
    o.description,
  ]
    .map((v) => (v != null && typeof v === "string" ? v : ""))
    .join(" ")
    .toLowerCase();

  const kindStr = String(o.kind || "").toLowerCase();
  if (kindStr.includes("included in") && !kindStr.includes("api")) return false;
  if (kindStr.includes("usage-based") || kindStr.includes("usage based")) return "unknown";

  const u = String(o.usageType || o.track || "").toLowerCase();
  if (u === "api" || (u.length && /\bapi\b/.test(u) && !/\bauto\b/.test(u))) return true;
  if (u === "default" || u.includes("composer") || u.includes("auto")) return false;

  if (/\bapi\s*pool\b/.test(parts) || /\(api\)/.test(parts)) return true;
  if (/(?:^|[^\w])api(?:[^\w]|$)/.test(String(o.kind || "").toLowerCase()) && !/\bauto/i.test(String(o.kind || "")))
    return true;
  if (parts.includes("api") && (parts.includes("pool") || /%\s*api/.test(parts))) return true;
  if (parts.includes("api") && !parts.includes("auto") && /pool|allowance|subscription/i.test(parts)) return true;

  if (parts.includes("auto") || parts.includes("composer") || /included(?!.*api)/i.test(parts)) return false;
  if (parts.includes("api")) return true;
  return "unknown";
}

/**
 * Same JSON body shape as https://cursor.com/dashboard/usage (see Network tab).
 * @param {string} partition
 * @param {number} startMs
 * @param {number} endMs inclusive end instant (ms)
 * @param {number} [teamId]
 * @param {Date} [periodStart] with `periodEnd`, sets Referer ?from=&to= like the browser
 * @param {Date} [periodEnd]
 * @returns {Promise<{ ok: boolean, status?: number, events: unknown[], pages: number, error?: string, textSample?: string, reportedTotal: number | null, lastResponseKeys: string[] | null, refererUsed: string, requestTransport: string }>}
 */
async function fetchAllUsageEventsPage(partition, startMs, endMs, teamId = 0, periodStart, periodEnd) {
  const refererUsed =
    periodStart instanceof Date && periodEnd instanceof Date
      ? formatUsagePageReferer(periodStart, periodEnd)
      : "https://cursor.com/dashboard/usage";
  const via = await fetchFilteredUsageEventsViaRendererWindow(partition, {
    apiUrl: USAGE_EVENTS_URL,
    refererUrl: refererUsed,
    startMs,
    endMs,
    teamId,
    maxPages: MAX_PAGES,
    pageSize: DEFAULT_PAGE_SIZE,
    requestTimeoutPerPage: USAGE_HTTP_TIMEOUT_MS,
  });
  if (!via.ok) {
    return {
      ok: false,
      pages: via.pages ?? 0,
      error: via.error || "usage_events_fetch_failed",
      textSample: via.textSample,
      events: [],
      reportedTotal: via.reportedTotal ?? null,
      lastResponseKeys: via.lastResponseKeys ?? null,
      refererUsed: via.refererUsed || refererUsed,
      requestTransport: via.requestTransport || "renderer_in_page",
    };
  }
  const all = /** @type {unknown[]} */ ([]);
  for (const j of via.pageBodies || []) {
    all.push(...extractEventsArray(j));
  }
  return {
    ok: true,
    events: all,
    pages: via.pages ?? 1,
    reportedTotal: via.reportedTotal ?? null,
    lastResponseKeys: via.lastResponseKeys ?? null,
    refererUsed: via.refererUsed || refererUsed,
    requestTransport: via.requestTransport || "renderer_in_page",
  };
}

/**
 * @param {number[]} cum
 * @param {number} curD
 * @param {number | null} endPercent
 * @returns {number[] | null}
 */
function scaleCumulativeToDisplayPercents(cum, curD, endPercent) {
  if (endPercent == null || !Number.isFinite(endPercent) || endPercent < 0) return null;
  const cap = Math.min(curD, cum.length - 1);
  if (cap < 0) return null;
  const endW = cum[cap] ?? 0;
  if (endW <= 0) {
    if (endPercent > 0) return null;
    return Array.from({ length: curD + 1 }, () => 0);
  }
  const out = [];
  for (let d = 0; d <= curD; d++) {
    const c = cum[Math.min(d, cum.length - 1)] ?? 0;
    out.push((c / endW) * endPercent);
  }
  return out;
}

/**
 * @param {string} partition
 * @param {{
 *   periodStart: Date,
 *   periodEnd: Date,
 *   daysTotal: number,
 *   currentDayIndex: number,
 * }} billing
 * @param {{ autoPercent: number | null, apiPercent: number | null, ok?: boolean }} stats
 * @returns {Promise<{
 *   ok: boolean,
 *   eventCount: number,
 *   pages: number,
 *   auto: number[] | null,
 *   api: number[] | null,
 *   error: string | null,
 *   bucketedCount: number,
 *   meta: Record<string, unknown> | null
 * }>}
 */
async function buildUsageEventSeriesForChart(partition, billing, stats) {
  if (!billing || !stats || stats.ok === false) {
    return {
      ok: false,
      eventCount: 0,
      pages: 0,
      auto: null,
      api: null,
      error: "no billing",
      bucketedCount: 0,
      meta: null,
    };
  }

  const periodStart = billing.periodStart;
  const periodEnd = billing.periodEnd;
  if (!(periodStart instanceof Date) || !(periodEnd instanceof Date)) {
    return {
      ok: false,
      eventCount: 0,
      pages: 0,
      auto: null,
      api: null,
      error: "invalid period",
      bucketedCount: 0,
      meta: null,
    };
  }

  const startMs = periodStart.getTime();
  const endMs = Math.max(startMs, periodEnd.getTime() - 1);
  const D = Math.max(1, billing.daysTotal);
  const curD = Math.max(0, Math.min(D, billing.currentDayIndex));
  const n = D + 1;

  const autoDay = new Array(n).fill(0);
  const apiDay = new Array(n).fill(0);
  const unknownDay = new Array(n).fill(0);

  const fetchResult = await fetchAllUsageEventsPage(partition, startMs, endMs, 0, periodStart, periodEnd);

  if (!fetchResult.ok) {
    return {
      ok: false,
      eventCount: 0,
      pages: fetchResult.pages ?? 0,
      auto: null,
      api: null,
      error: fetchResult.error || "fetch failed",
      bucketedCount: 0,
      meta: {
        dataSource: USAGE_EVENTS_URL,
        transport: "Hidden window loads /dashboard/usage then in-page fetch (credentials include).",
        requestTransport: fetchResult.requestTransport,
        ok: false,
        error: fetchResult.error || "fetch failed",
        textSample: fetchResult.textSample,
        pages: fetchResult.pages ?? 0,
        reportedTotal: fetchResult.reportedTotal ?? null,
        startMs,
        endMs,
        daysTotal: D,
        currentDayIndex: curD,
        refererUsed: fetchResult.refererUsed,
        apiResponseTopLevelKeys: fetchResult.lastResponseKeys,
      },
    };
  }

  const events = fetchResult.events;
  const pagesFetched = fetchResult.pages ?? 0;
  if (events.length === 0) {
    return {
      ok: true,
      eventCount: 0,
      pages: pagesFetched,
      auto: null,
      api: null,
      error: null,
      bucketedCount: 0,
      meta: {
        dataSource: USAGE_EVENTS_URL,
        transport: "Hidden window loads /dashboard/usage then in-page fetch (credentials include).",
        requestTransport: fetchResult.requestTransport,
        startMs,
        endMs,
        daysTotal: D,
        currentDayIndex: curD,
        reportedTotal: fetchResult.reportedTotal ?? null,
        fetched: 0,
        bucketed: 0,
        refererUsed: fetchResult.refererUsed,
        apiResponseTopLevelKeys: fetchResult.lastResponseKeys,
        note:
          "No events in range for this request, or JSON had no event array (see apiResponseTopLevelKeys). If keys are only teamId/startDate/endDate/page/pageSize, the server echoed the body and did not return rows — check session, Referer ?from=&to=, or compare with DevTools.",
      },
    };
  }

  let bucketedCount = 0;
  let skippedNoTime = 0;
  let skippedOutOfRange = 0;
  let skippedBadDayIndex = 0;
  let skippedZeroWeight = 0;
  let timeMsMin = /** @type {number | null} */ (null);
  let timeMsMax = /** @type {number | null} */ (null);
  const dayIndicesWithWeight = new Set();
  for (const ev of events) {
    const t = getEventTimeMs(ev);
    if (t == null) {
      skippedNoTime += 1;
      continue;
    }
    if (t < startMs - 24 * 3600000 || t > endMs + 24 * 3600000) {
      skippedOutOfRange += 1;
      continue;
    }
    const di = dayIndexInBillingPeriod(periodStart, t);
    if (di < 0 || di >= n) {
      skippedBadDayIndex += 1;
      continue;
    }
    const w = getEventWeight(ev);
    if (w <= 0) {
      skippedZeroWeight += 1;
      continue;
    }
    bucketedCount += 1;
    if (timeMsMin == null || t < timeMsMin) timeMsMin = t;
    if (timeMsMax == null || t > timeMsMax) timeMsMax = t;
    dayIndicesWithWeight.add(di);
    const kind = classifyPool(ev);
    if (kind === true) {
      apiDay[di] += w;
    } else if (kind === false) {
      autoDay[di] += w;
    } else {
      unknownDay[di] += w;
    }
  }
  const dis = [...dayIndicesWithWeight].sort((a, b) => a - b);
  const minDayIndex = dis.length > 0 ? dis[0] : null;
  const maxDayIndex = dis.length > 0 ? dis[dis.length - 1] : null;

  const apAuto = stats.autoPercent != null ? Math.max(0, stats.autoPercent) : 0;
  const apApi = stats.apiPercent != null ? Math.max(0, stats.apiPercent) : 0;
  const sumP = apAuto + apApi;
  if (sumP > 0) {
    for (let i = 0; i < n; i++) {
      const u = unknownDay[i];
      if (u <= 0) continue;
      autoDay[i] += (u * apAuto) / sumP;
      apiDay[i] += (u * apApi) / sumP;
    }
  } else {
    for (let i = 0; i < n; i++) {
      autoDay[i] += unknownDay[i];
    }
  }

  const autoCum = new Array(n);
  const apiCum = new Array(n);
  autoCum[0] = autoDay[0];
  apiCum[0] = apiDay[0];
  for (let i = 1; i < n; i++) {
    autoCum[i] = autoCum[i - 1] + autoDay[i];
    apiCum[i] = apiCum[i - 1] + apiDay[i];
  }

  const autoSeries = scaleCumulativeToDisplayPercents(autoCum, curD, stats.autoPercent);
  const apiSeries = scaleCumulativeToDisplayPercents(apiCum, curD, stats.apiPercent);

  return {
    ok: true,
    eventCount: events.length,
    pages: pagesFetched,
    auto: autoSeries,
    api: apiSeries,
    error: null,
    bucketedCount,
    meta: {
      dataSource: USAGE_EVENTS_URL,
      transport: "Hidden window loads /dashboard/usage then in-page fetch (credentials include).",
      requestTransport: fetchResult.requestTransport,
      startMs,
      endMs,
      daysTotal: D,
      currentDayIndex: curD,
      dayIndexMode: "ms_from_period_start",
      reportedTotal: fetchResult.reportedTotal ?? null,
      fetched: events.length,
      pages: pagesFetched,
      bucketed: bucketedCount,
      skippedNoTime,
      skippedOutOfRange,
      skippedBadDayIndex,
      skippedZeroWeight,
      timeMsMin,
      timeMsMax,
      distinctDayBuckets: dayIndicesWithWeight.size,
      minDayIndex,
      maxDayIndex,
      refererUsed: fetchResult.refererUsed,
      apiResponseTopLevelKeys: fetchResult.lastResponseKeys,
    },
  };
}

module.exports = {
  USAGE_EVENTS_URL,
  extractEventsArray,
  buildUsageEventSeriesForChart,
  formatUsagePageReferer,
};
