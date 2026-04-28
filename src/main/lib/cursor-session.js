/**
 * Authenticated requests to cursor.com using the persisted session partition.
 * @see https://cursor.com/api/auth/me
 * @see docs/ARCHITECTURE.md
 */

const { net, session, BrowserWindow } = require("electron");
const { parseCurrentPeriodUsage } = require("./parse-current-period-usage.js");

const CURRENT_PERIOD_USAGE_URL = "https://cursor.com/api/dashboard/get-current-period-usage";
const AGGREGATED_USAGE_EVENTS_URL = "https://cursor.com/api/dashboard/get-aggregated-usage-events";

/**
 * @param {string} partition
 * @param {string} url
 * @param {RequestInit & { timeoutMs?: number }} [init]
 */
async function cursorFetch(partition, url, init = {}) {
  const ses = session.fromPartition(partition);
  const timeoutMs = typeof init.timeoutMs === "number" && init.timeoutMs > 0 ? init.timeoutMs : 0;
  const { timeoutMs: _omit, ...userInit } = init;
  const controller = new AbortController();
  const t =
    timeoutMs > 0 && !userInit.signal
      ? setTimeout(() => {
          try {
            controller.abort();
          } catch {
            /* ignore */
          }
        }, timeoutMs)
      : null;
  let res;
  let text;
  try {
    res = await net.fetch(url, {
      ...userInit,
      session: ses,
      signal: timeoutMs > 0 && !userInit.signal ? controller.signal : userInit.signal,
      headers: {
        Accept: "application/json, text/plain, */*",
        ...userInit.headers,
      },
    });
    text = await res.text();
  } catch (e) {
    if (t) clearTimeout(t);
    const isAbort = e && (e.name === "AbortError" || /abort|cancel/i.test(String(e && e.message)));
    if (isAbort) {
      return { ok: false, status: 0, json: null, text: "Request timeout", aborted: true };
    }
    throw e;
  }
  if (t) clearTimeout(t);
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { ok: res.ok, status: res.status, json, text: text.slice(0, 50000) };
}

/** Load this before API calls that expect dashboard session cookies. */
const RENDERER_LOAD_DASHBOARD = "https://cursor.com/dashboard";
const RENDERER_LOAD_BILLING = "https://cursor.com/dashboard/billing";

/** Endpoints to probe for extra usage JSON (best-effort; shapes change). /auth/me is fetched separately. */
const USAGE_PROBE_URLS = [
  "https://cursor.com/api/dashboard/billing",
  "https://cursor.com/api/usage",
  "https://cursor.com/api/usage/current",
  "https://cursor.com/api/user/usage",
  "https://cursor.com/api/billing/summary",
];

/**
 * Same as {@link cursorFetch} but: open a hidden window, `loadURL(loadUrl)`, then run
 * `fetch(requestUrl, { credentials: "include" })` in the page. Fixes auth for APIs that
 * reject `net.fetch` (avatar from /api/auth/me, on-demand from get-current-period-usage, etc.).
 * @param {string} partition
 * @param {string} loadUrl
 * @param {string} requestUrl
 * @param {RequestInit & { timeoutMs?: number }} [init]
 * @returns {Promise<{ ok: boolean, status: number, json: unknown, text: string, aborted: boolean }>}
 */
async function cursorFetchViaRenderer(partition, loadUrl, requestUrl, init = {}) {
  const loadTimeoutMs = 25000;
  const timeoutMs = typeof init.timeoutMs === "number" && init.timeoutMs > 0 ? init.timeoutMs : 15000;
  const method = String(init.method || "GET").toUpperCase();
  const headerObj = { Accept: "application/json, text/plain, */*" };
  if (init.headers && typeof init.headers === "object" && !Array.isArray(init.headers)) {
    for (const [k, v] of Object.entries(init.headers)) {
      if (v != null) headerObj[k] = String(v);
    }
  }
  let bodyStr = null;
  if (init.body != null) {
    bodyStr = typeof init.body === "string" ? init.body : JSON.stringify(init.body);
  }
  const win = new BrowserWindow({
    show: false,
    webPreferences: { partition, contextIsolation: true, nodeIntegration: false },
  });
  try {
    await Promise.race([
      win.loadURL(loadUrl),
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error("renderer_load_timeout")), loadTimeoutMs);
      }),
    ]);
    await new Promise((r) => setTimeout(r, 300));
  } catch (e) {
    if (!win.isDestroyed()) {
      try {
        win.destroy();
      } catch {
        /* ignore */
      }
    }
    return {
      ok: false,
      status: 0,
      json: null,
      text: e instanceof Error ? e.message : String(e),
      aborted: false,
    };
  }
  const script = `(async () => {
    const RU = ${JSON.stringify(requestUrl)};
    const M = ${JSON.stringify(method)};
    const H = ${JSON.stringify(headerObj)};
    const B = ${bodyStr === null ? "null" : JSON.stringify(bodyStr)};
    const rt = ${timeoutMs};
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), rt);
    try {
      const opts = { method: M, credentials: "include", headers: H, signal: ac.signal };
      if (B != null && (M === "POST" || M === "PUT" || M === "PATCH" || (M === "DELETE" && B.length))) {
        opts.body = B;
      }
      const res = await fetch(RU, opts);
      clearTimeout(t);
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch (e) {}
      return { ok: res.ok, status: res.status, json, text: text.slice(0, 50000), aborted: false };
    } catch (e) {
      clearTimeout(t);
      const isAbort = e && e.name === "AbortError";
      return { ok: false, status: 0, json: null, text: String((e && e.message) || e), aborted: isAbort };
    }
  })()`;
  let out;
  try {
    out = await win.webContents.executeJavaScript(script);
  } catch (e) {
    if (!win.isDestroyed()) {
      try {
        win.destroy();
      } catch {
        /* ignore */
      }
    }
    return {
      ok: false,
      status: 0,
      json: null,
      text: e instanceof Error ? e.message : String(e),
      aborted: false,
    };
  }
  if (!win.isDestroyed()) {
    try {
      win.destroy();
    } catch {
      /* ignore */
    }
  }
  if (!out || typeof out !== "object") {
    return { ok: false, status: 0, json: null, text: "bad_executeJavaScript_result", aborted: false };
  }
  const o = /** @type {Record<string, unknown>} */ (out);
  return {
    ok: Boolean(o.ok),
    status: typeof o.status === "number" ? o.status : 0,
    json: o.json ?? null,
    text: typeof o.text === "string" ? o.text : String(o.text || ""),
    aborted: Boolean(o.aborted),
  };
}

/**
 * One hidden window, then GET each probe URL with credentials (same as browser).
 * @param {string} partition
 */
async function probeUsageApisViaRenderer(partition) {
  const loadUrl = RENDERER_LOAD_BILLING;
  const perUrlMs = 12000;
  const win = new BrowserWindow({
    show: false,
    webPreferences: { partition, contextIsolation: true, nodeIntegration: false },
  });
  const loadTimeoutMs = 25000;
  try {
    await Promise.race([
      win.loadURL(loadUrl),
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error("probe_load_timeout")), loadTimeoutMs);
      }),
    ]);
    await new Promise((r) => setTimeout(r, 300));
  } catch (e) {
    if (!win.isDestroyed()) {
      try {
        win.destroy();
      } catch {
        /* ignore */
      }
    }
    return USAGE_PROBE_URLS.map((url) => ({
      url,
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    }));
  }
  const script = `(async () => {
    const urls = ${JSON.stringify(USAGE_PROBE_URLS)};
    const per = ${perUrlMs};
    const out = [];
    for (const u of urls) {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), per);
      try {
        const res = await fetch(u, { credentials: "include", signal: ac.signal });
        clearTimeout(timer);
        const text = await res.text();
        let json = null;
        try { json = JSON.parse(text); } catch (e) {}
        out.push({ url: u, ok: res.ok, status: res.status, json, text: text.slice(0, 5000) });
      } catch (e) {
        clearTimeout(timer);
        out.push({ url: u, ok: false, error: String((e && e.message) || e) });
      }
    }
    return out;
  })()`;
  let rows;
  try {
    rows = await win.webContents.executeJavaScript(script);
  } catch (e) {
    if (!win.isDestroyed()) {
      try {
        win.destroy();
      } catch {
        /* ignore */
      }
    }
    return USAGE_PROBE_URLS.map((url) => ({
      url,
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    }));
  }
  if (!win.isDestroyed()) {
    try {
      win.destroy();
    } catch {
      /* ignore */
    }
  }
  if (!Array.isArray(rows)) {
    return USAGE_PROBE_URLS.map((url) => ({ url, ok: false, error: "bad_probe_result" }));
  }
  const results = [];
  for (const row of rows) {
    if (row && row.error) {
      results.push({ url: row.url, ok: false, error: String(row.error) });
      continue;
    }
    if (!row || typeof row !== "object") {
      results.push({ url: "", ok: false, error: "bad_row" });
      continue;
    }
    const r = /** @type {Record<string, unknown>} */ (row);
    const j = r.json;
    const url = typeof r.url === "string" ? r.url : "";
    const hasUsefulJson =
      j && typeof j === "object" && url !== "https://cursor.com/api/auth/me" && Object.keys(j).length > 0;
    results.push({
      url,
      ok: Boolean(r.ok),
      status: typeof r.status === "number" ? r.status : 0,
      hasJson: j != null,
      keys: j && typeof j === "object" && !Array.isArray(j) ? Object.keys(/** @type {object} */ (j)).slice(0, 20) : [],
      sample: hasUsefulJson ? JSON.stringify(j).slice(0, 400) : null,
    });
  }
  return results;
}

const IMAGEUrl_RE = /(https?:\/\/[^\s"'<>]+|\/[^\s"'<>]*\.(png|jpe?g|webp|gif|svg))(\?[^\s"'<>]*)?/i;

/**
 * Cursor profile photos are often served from WorkOS without a file extension.
 * @param {string} s
 * @returns {boolean}
 */
function isLikelyProfileImageUrl(s) {
  if (typeof s !== "string") return false;
  const t = s.trim();
  if (t.length < 8 || t.length > 2000) return false;
  if (!/^https?:\/\//i.test(t) && !t.startsWith("/")) return false;
  if (/workoscdn\.com/i.test(t)) return true;
  if (/images\/v\d+\/[\w-]+/i.test(t)) return true;
  if (/\.(png|jpe?g|webp|gif|svg)(\?|$)/i.test(t)) return true;
  if (/(gravatar|githubusercontent|googleusercontent|cloudinary|avatar)/i.test(t)) return true;
  return false;
}

/**
 * @param {unknown} obj
 * @param {number} depth
 * @returns {string | null}
 */
function extractAvatarUrlFromTree(obj, depth = 0) {
  if (depth > 10 || obj == null) return null;
  if (typeof obj === "string") {
    const s = obj.trim();
    if (s.length < 8 || s.length > 2000) return null;
    if (!/^https?:\/\//i.test(s) && !s.startsWith("/")) return null;
    if (isLikelyProfileImageUrl(s)) return s;
    return null;
  }
  if (Array.isArray(obj)) {
    for (const v of obj) {
      const f = extractAvatarUrlFromTree(v, depth + 1);
      if (f) return f;
    }
    return null;
  }
  if (typeof obj === "object") {
    for (const [k, v] of Object.entries(obj)) {
      const kl = k.toLowerCase();
      if (
        typeof v === "string" &&
        (kl.includes("avatar") ||
          kl.includes("photo") ||
          kl.includes("picture") ||
          kl === "image" ||
          kl === "imageurl" ||
          kl.endsWith("url"))
      ) {
        const s = v.trim();
        if ((/^https?:\/\//i.test(s) || s.startsWith("/")) && s.length < 2000) return s;
      }
      if (typeof v === "string" && IMAGEUrl_RE.test(v) && (kl.includes("user") || kl.includes("profile"))) {
        const m = v.match(IMAGEUrl_RE);
        if (m) return m[1] || m[0];
      }
    }
    for (const v of Object.values(obj)) {
      const f = extractAvatarUrlFromTree(v, depth + 1);
      if (f) return f;
    }
  }
  return null;
}

function mergeRootUser(json) {
  const base = json;
  if (!base || typeof base !== "object" || Array.isArray(base)) return base;
  const direct = { ...base };
  const u = base.user;
  if (u && typeof u === "object" && !Array.isArray(u)) {
    for (const k of [
      "picture",
      "imageUrl",
      "avatarUrl",
      "avatar_url",
      "image_url",
      "image",
      "profileImage",
      "profilePicture",
      "profileImageUrl",
      "email",
      "name",
      "id",
    ]) {
      if (u[k] != null && direct[k] == null) direct[k] = u[k];
    }
  }
  return direct;
}

function normalizeMe(json) {
  if (!json || typeof json !== "object" || Array.isArray(json)) return null;
  const merged = mergeRootUser(json);
  const root =
    merged.user && typeof merged.user === "object" && merged.email == null && merged.name == null
      ? merged.user
      : merged.data && typeof merged.data === "object"
        ? merged.data
        : merged;
  const email = root.email ?? root.primaryEmail ?? root.user?.email ?? null;
  const name =
    root.name ??
    root.displayName ??
    root.user?.name ??
    (email ? String(email).split("@")[0] : null);
  /** `sub` is the stable WorkOS subject (e.g. user_01…); keep even when numeric `id` is also present. */
  const sub = typeof root.sub === "string" && root.sub ? root.sub : null;
  const id =
    root.id != null
      ? root.id
      : root.userId != null
        ? root.userId
        : typeof root.sub === "number"
          ? root.sub
          : null;
  const plan =
    root.plan ?? root.subscription?.plan ?? root.subscriptionTier ?? root.tier ?? null;
  const email_verified =
    typeof root.email_verified === "boolean" ? root.email_verified : null;
  const created_at = typeof root.created_at === "string" ? root.created_at : null;
  const updated_at = typeof root.updated_at === "string" ? root.updated_at : null;
  const prof = root.profile && typeof root.profile === "object" && !Array.isArray(root.profile) ? root.profile : null;
  let picture =
    root.picture ??
    root.avatarUrl ??
    root.avatar_url ??
    root.imageUrl ??
    root.image_url ??
    root.image ??
    root.profileImageUrl ??
    root.profileImage ??
    root.profilePicture ??
    root.profilePictureUrl ??
    root.avatar ??
    root.photoUrl ??
    root.user?.picture ??
    root.user?.imageUrl ??
    root.user?.avatarUrl ??
    root.user?.avatar_url ??
    root.user?.profileImage ??
    prof?.picture ??
    prof?.imageUrl ??
    prof?.avatarUrl ??
    prof?.image ??
    null;
  if (typeof picture !== "string" || !picture) {
    picture = extractAvatarUrlFromTree(json) || null;
  }
  return {
    email,
    name,
    id,
    sub,
    plan,
    email_verified,
    created_at,
    updated_at,
    picture: typeof picture === "string" && picture ? picture : null,
  };
}

/**
 * @param {string} partition
 * @param {RequestInit & { timeoutMs?: number }} [init] e.g. `timeoutMs` for a fast fail
 */
async function fetchAuthMe(partition, init = {}) {
  const timeoutMs =
    typeof init.timeoutMs === "number" && init.timeoutMs > 0 ? init.timeoutMs : 12000;
  const r = await cursorFetchViaRenderer(
    partition,
    RENDERER_LOAD_DASHBOARD,
    "https://cursor.com/api/auth/me",
    { method: "GET", timeoutMs },
  );
  if (r.aborted) {
    return { ok: false, status: 0, error: "Request timeout", user: null };
  }
  if (!r.ok) {
    return {
      ok: false,
      status: r.status,
      error: r.json ? null : r.text.slice(0, 300),
      user: null,
    };
  }
  const emptyBody = r.status === 204 || (typeof r.text === "string" && r.text.trim() === "");
  if (emptyBody) {
    return {
      ok: true,
      status: r.status,
      user: null,
      noBody: true,
    };
  }
  if (!r.json) {
    return {
      ok: false,
      status: r.status,
      error: r.text.slice(0, 300),
      user: null,
    };
  }
  let user = normalizeMe(r.json);
  if (!user && r.json && typeof r.json === "object" && !Array.isArray(r.json)) {
    const pic = extractAvatarUrlFromTree(r.json);
    user = { email: null, name: null, id: null, plan: null, picture: pic };
  } else if (user && !user.picture) {
    const pic = extractAvatarUrlFromTree(r.json);
    if (pic) user = { ...user, picture: pic };
  }
  return { ok: true, status: r.status, user, raw: r.json };
}

async function probeUsageApis(partition) {
  return probeUsageApisViaRenderer(partition);
}

/**
 * On-demand / usage-based spend for the current billing period (dashboard API).
 * @param {string} partition
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<{
 *   ok: boolean,
 *   amountUsd: number | null,
 *   usedUsd: number | null,
 *   limitUsd: number | null,
 *   remainingUsd: number | null,
 *   error?: string
 * }>}
 */
async function fetchCurrentPeriodUsage(partition, opts = {}) {
  const timeoutMs = typeof opts.timeoutMs === "number" && opts.timeoutMs > 0 ? opts.timeoutMs : 15000;
  try {
    const r = await cursorFetchViaRenderer(
      partition,
      RENDERER_LOAD_BILLING,
      CURRENT_PERIOD_USAGE_URL,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "*/*",
          Origin: "https://cursor.com",
          Referer: "https://cursor.com/dashboard/billing",
        },
        body: "{}",
        timeoutMs,
      },
    );
    if (r.aborted) {
      return {
        ok: false,
        amountUsd: null,
        usedUsd: null,
        limitUsd: null,
        remainingUsd: null,
        error: "Request timeout",
      };
    }
    if (!r.ok) {
      const err =
        (r.json && typeof r.json === "object" && r.json.error && String(r.json.error)) ||
        r.text.slice(0, 200) ||
        "Request failed";
      return {
        ok: false,
        amountUsd: null,
        usedUsd: null,
        limitUsd: null,
        remainingUsd: null,
        error: String(err),
      };
    }
    if (r.json == null || typeof r.json !== "object") {
      return {
        ok: false,
        amountUsd: null,
        usedUsd: null,
        limitUsd: null,
        remainingUsd: null,
        error: "Invalid JSON",
      };
    }
    const p = parseCurrentPeriodUsage(r.json);
    const hasUsed = p.amountUsd != null && p.amountUsd > 0;
    return {
      ok: true,
      amountUsd: hasUsed ? p.amountUsd : null,
      usedUsd: p.usedUsd,
      limitUsd: p.limitUsd,
      remainingUsd: p.remainingUsd,
    };
  } catch (e) {
    return {
      ok: false,
      amountUsd: null,
      usedUsd: null,
      limitUsd: null,
      remainingUsd: null,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/**
 * Billing-period spend by `modelIntent` (reasoning tier encoded in the string, not the docs table name).
 * Uses the same in-page fetch as {@link fetchCurrentPeriodUsage} so session cookies apply.
 * Response `totalCents` is not literal cents in practice; the client divides by 100 for USD (see model-usage-match).
 *
 * @param {string} partition
 * @param {number} startDateMs Period start (epoch ms), e.g. billing window `periodStart.getTime()`
 * @param {{ teamId?: number, timeoutMs?: number }} [opts] `teamId: -1` = personal (matches web dashboard)
 */
async function fetchAggregatedUsageEvents(partition, startDateMs, opts = {}) {
  const timeoutMs = typeof opts.timeoutMs === "number" && opts.timeoutMs > 0 ? opts.timeoutMs : 20000;
  const teamId = typeof opts.teamId === "number" ? opts.teamId : -1;
  const start = typeof startDateMs === "number" && Number.isFinite(startDateMs) ? startDateMs : 0;
  try {
    const body = JSON.stringify({ teamId, startDate: start });
    const r = await cursorFetchViaRenderer(partition, RENDERER_LOAD_BILLING, AGGREGATED_USAGE_EVENTS_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "*/*",
        Origin: "https://cursor.com",
        Referer: "https://cursor.com/dashboard/billing",
      },
      body,
      timeoutMs,
    });
    if (r.aborted) {
      return { ok: false, json: null, error: "Request timeout" };
    }
    if (!r.ok) {
      const err =
        (r.json && typeof r.json === "object" && r.json.error && String(r.json.error)) ||
        r.text.slice(0, 300) ||
        "Request failed";
      return { ok: false, json: null, error: String(err) };
    }
    if (r.json == null || typeof r.json !== "object") {
      return { ok: false, json: null, error: "Invalid JSON" };
    }
    return { ok: true, json: r.json, error: null };
  } catch (e) {
    return {
      ok: false,
      json: null,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/**
 * Load the usage dashboard then run `fetch()` in the page context with `credentials: "include"`.
 * Cursor's `get-filtered-usage-events` often returns { error: "not_authenticated" } for
 * `net.fetch` + session cookies; the in-page request matches the browser and succeeds.
 * @param {string} partition
 * @param {{
 *   apiUrl: string,
 *   refererUrl: string,
 *   startMs: number,
 *   endMs: number,
 *   teamId: number,
 *   maxPages: number,
 *   pageSize: number,
 *   loadTimeoutMs?: number,
 *   requestTimeoutPerPage?: number,
 * }} p
 */
async function fetchFilteredUsageEventsViaRendererWindow(partition, p) {
  const {
    apiUrl,
    refererUrl,
    startMs,
    endMs,
    teamId,
    maxPages,
    pageSize,
    loadTimeoutMs = 25000,
    requestTimeoutPerPage = 20000,
  } = p;

  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      partition,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  try {
    await Promise.race([
      win.loadURL(refererUrl),
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error("usage_page_load_timeout")), loadTimeoutMs);
      }),
    ]);
    await new Promise((r) => setTimeout(r, 400));
  } catch (e) {
    if (!win.isDestroyed()) {
      try {
        win.destroy();
      } catch {
        /* ignore */
      }
    }
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
      pageBodies: [],
      pages: 0,
      reportedTotal: null,
      lastResponseKeys: null,
      refererUsed: refererUrl,
      requestTransport: "renderer_in_page",
    };
  }

  const script = `(async () => {
    const U = ${JSON.stringify(apiUrl)};
    const startDate = String(${Number(startMs)});
    const endDate = String(${Number(endMs)});
    const tid = ${Number(teamId) | 0};
    const maxP = ${Number(maxPages)};
    const ps = ${Number(pageSize)};
    const rt = ${Number(requestTimeoutPerPage)};
    function bl(j) {
      if (j == null || typeof j !== "object" || Array.isArray(j)) return 0;
      if (Array.isArray(j.data)) return j.data.length;
      const keys = [
        "usageEventsDisplay", "usageEvents", "usageEventList", "events", "items",
        "rows", "records", "list", "hits", "results", "eventList", "usageEventRows",
      ];
      for (const k of keys) {
        if (Array.isArray(j[k])) return j[k].length;
      }
      return 0;
    }
    const pageBodies = [];
    let pages = 0;
    let reportedTotal = null;
    let lastKeys = null;
    for (let page = 1; page <= maxP; page++) {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), rt);
      let res;
      try {
        res = await fetch(U, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            teamId: tid,
            startDate,
            endDate,
            page,
            pageSize: ps,
          }),
          signal: ac.signal,
        });
      } catch (e) {
        clearTimeout(timer);
        const msg = e && e.name === "AbortError" ? "timeout" : String((e && e.message) || e);
        return { ok: false, error: msg, pageBodies, pages, reportedTotal, lastResponseKeys: lastKeys };
      }
      clearTimeout(timer);
      const text = await res.text();
      let j = null;
      try {
        j = JSON.parse(text);
      } catch {
        return {
          ok: false,
          error: "invalid_json",
          textSample: text.slice(0, 200),
          pageBodies,
          pages,
        };
      }
      if (j && typeof j === "object" && !Array.isArray(j)) {
        lastKeys = Object.keys(j);
      }
      if (!res.ok) {
        const err =
          j && typeof j === "object" && j !== null && "error" in j && j.error != null
            ? String(j.error)
            : "HTTP " + res.status;
        return { ok: false, error: err, pageBodies, pages, lastResponseKeys: lastKeys, reportedTotal };
      }
      if (j && typeof j === "object" && j !== null && "error" in j && j.error) {
        return { ok: false, error: String(j.error), pageBodies, pages, lastResponseKeys: lastKeys, reportedTotal };
      }
      pageBodies.push(j);
      pages = page;
      const tot =
        j && typeof j === "object" && j !== null && "totalUsageEventsCount" in j
          ? Number(j.totalUsageEventsCount)
          : j && typeof j === "object" && j !== null && "total" in j
            ? Number(j.total)
            : null;
      if (tot != null && !Number.isNaN(tot)) reportedTotal = tot;
      const bln = bl(j);
      if (bln < ps) break;
      if (reportedTotal != null) {
        let c = 0;
        for (const b of pageBodies) c += bl(b);
        if (c >= reportedTotal) break;
      }
    }
    return { ok: true, pageBodies, pages, reportedTotal, lastResponseKeys: lastKeys };
  })()`;

  let out;
  try {
    out = await win.webContents.executeJavaScript(script);
  } catch (e) {
    if (!win.isDestroyed()) {
      try {
        win.destroy();
      } catch {
        /* ignore */
      }
    }
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
      pageBodies: [],
      pages: 0,
      reportedTotal: null,
      lastResponseKeys: null,
      refererUsed: refererUrl,
      requestTransport: "renderer_in_page",
    };
  }

  if (!win.isDestroyed()) {
    try {
      win.destroy();
    } catch {
      /* ignore */
    }
  }

  if (!out || typeof out !== "object") {
    return {
      ok: false,
      error: "bad_renderer_result",
      pageBodies: [],
      pages: 0,
      reportedTotal: null,
      lastResponseKeys: null,
      refererUsed: refererUrl,
      requestTransport: "renderer_in_page",
    };
  }

  const o = /** @type {Record<string, unknown>} */ (out);
  if (o.ok === true) {
    return {
      ok: true,
      pageBodies: Array.isArray(o.pageBodies) ? o.pageBodies : [],
      pages: typeof o.pages === "number" ? o.pages : 1,
      reportedTotal: o.reportedTotal != null && typeof o.reportedTotal === "number" ? o.reportedTotal : null,
      lastResponseKeys: Array.isArray(o.lastResponseKeys) ? o.lastResponseKeys : null,
      refererUsed: refererUrl,
      requestTransport: "renderer_in_page",
    };
  }
  return {
    ok: false,
    error: typeof o.error === "string" ? o.error : "usage_events_failed",
    textSample: typeof o.textSample === "string" ? o.textSample : undefined,
    pageBodies: Array.isArray(o.pageBodies) ? o.pageBodies : [],
    pages: typeof o.pages === "number" ? o.pages : 0,
    reportedTotal: o.reportedTotal != null && typeof o.reportedTotal === "number" ? o.reportedTotal : null,
    lastResponseKeys: Array.isArray(o.lastResponseKeys) ? o.lastResponseKeys : null,
    refererUsed: refererUrl,
    requestTransport: "renderer_in_page",
  };
}

module.exports = {
  cursorFetch,
  cursorFetchViaRenderer,
  fetchAuthMe,
  fetchCurrentPeriodUsage,
  fetchAggregatedUsageEvents,
  probeUsageApis,
  normalizeMe,
  USAGE_PROBE_URLS,
  RENDERER_LOAD_DASHBOARD,
  RENDERER_LOAD_BILLING,
  extractAvatarUrlFromTree,
  isLikelyProfileImageUrl,
  CURRENT_PERIOD_USAGE_URL,
  AGGREGATED_USAGE_EVENTS_URL,
  fetchFilteredUsageEventsViaRendererWindow,
};
