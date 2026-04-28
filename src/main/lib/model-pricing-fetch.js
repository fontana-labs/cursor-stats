/**
 * Resolve model pricing by loading Cursor docs in a hidden BrowserWindow and reading
 * hydrated DOM tables (initial HTML fetch does not include pricing rows).
 *
 * No disk or memory cache — each resolve runs a fresh scrape (concurrent callers share one in-flight scrape).
 */

const { BrowserWindow } = require("electron");

const LOG_PREFIX = "[model-pricing]";

function logInfo(...args) {
  console.info(LOG_PREFIX, ...args);
}

function logWarn(...args) {
  console.warn(LOG_PREFIX, ...args);
}

function logErr(...args) {
  console.error(LOG_PREFIX, ...args);
}

const PRICING_DOCS_URL = "https://cursor.com/docs/models-and-pricing#model-pricing";
const POOLS_DOC_URL = "https://cursor.com/docs/models-and-pricing";

const LOAD_TIMEOUT_MS = 28000;
const DOM_POLL_DEADLINE_MS = 26000;
/** Collapsed docs preview ~7 rows; expanded full grid has many more — avoids accepting partial HTML before "Show more models". */
const MIN_MODEL_ROWS = 12;

/** @type {Promise<{ ok: boolean, data?: Record<string, unknown>, error?: string, meta?: Record<string, unknown> }> | null} */
let resolveInflight = null;

/**
 * Deletes `userData/model-pricing-cache.json` if present (legacy; we no longer read it).
 */
function removeLegacyDiskCacheFile() {
  try {
    const fs = require("fs");
    const path = require("path");
    const { app } = require("electron");
    const p = path.join(app.getPath("userData"), "model-pricing-cache.json");
    if (fs.existsSync(p)) {
      fs.unlinkSync(p);
      logInfo("removed legacy model-pricing-cache.json");
    }
  } catch (e) {
    logWarn("legacy cache removal skipped:", e instanceof Error ? e.message : String(e));
  }
}

/**
 * Runs inside the docs page — polls until model-pricing table exists (RSC hydration).
 */
const SCRAPER_SCRIPT = `(async () => {
  function parseUsd(el) {
    if (!el) return null;
    const t = String(el.innerText || "")
      .trim()
      .replace(/[$,]/g, "")
      .replace(/^−/, "-");
    if (t === "-" || t === "" || t === "—" || /^n[/.]?a$/i.test(t)) return null;
    const n = parseFloat(t);
    return Number.isFinite(n) ? n : null;
  }

  function normHeader(h) {
    return String(h || "")
      .trim()
      .toLowerCase()
      .replace(/\\s+/g, " ");
  }

  function tableDebugSnapshot() {
    const tables = Array.from(document.querySelectorAll("table"));
    const snapshots = [];
    for (let ti = 0; ti < Math.min(tables.length, 12); ti++) {
      const t = tables[ti];
      const theadRow = t.querySelector("thead tr");
      const fr = theadRow || t.rows[0];
      const labels = fr
        ? Array.from(fr.querySelectorAll("th, td")).map((c) => normHeader(c.innerText)).slice(0, 12)
        : [];
      const tbodyRows = t.querySelectorAll("tbody tr").length;
      snapshots.push({ index: ti, headerCells: labels, tbodyRows });
    }
    return { tableCount: tables.length, tables: snapshots };
  }

  const deadline = Date.now() + ${DOM_POLL_DEADLINE_MS};
  const MIN_ROWS = ${MIN_MODEL_ROWS};
  let lastParsedLen = 0;

  while (Date.now() < deadline) {
    /* Cursor collapses long pricing grids — expand before tbody fills */
    const expandBtn = Array.from(document.querySelectorAll("button")).find((b) => {
      const t = String(b.innerText || b.textContent || "").trim();
      return /show more models/i.test(t);
    });
    if (expandBtn) {
      try {
        expandBtn.click();
      } catch (e) {}
      await new Promise((r) => setTimeout(r, 800));
      continue;
    }

    const tables = Array.from(document.querySelectorAll("table"));
    let autoPool = null;
    let models = null;

    for (const table of tables) {
      const theadRow = table.querySelector("thead tr");
      const firstRow = theadRow || table.rows[0];
      if (!firstRow) continue;
      const headerCells = Array.from(firstRow.querySelectorAll("th, td")).map((c) =>
        normHeader(c.innerText),
      );
      const joined = headerCells.join("|");

      if (
        headerCells.some((h) => h.includes("token")) &&
        headerCells.some((h) => h.includes("price"))
      ) {
        const rows = Array.from(table.querySelectorAll("tbody tr")).filter(Boolean);
        const pool = {
          inputCacheWrite: null,
          output: null,
          cacheRead: null,
        };
        for (const tr of rows) {
          const cells = Array.from(tr.querySelectorAll("td"));
          if (cells.length < 2) continue;
          const label = normHeader(cells[0].innerText);
          const price = parseUsd(cells[1]);
          if (label.includes("input") && label.includes("cache") && label.includes("write")) {
            pool.inputCacheWrite = price;
          } else if (/^output\\b/.test(label) || label === "output") {
            pool.output = price;
          } else if (label.includes("cache") && label.includes("read")) {
            pool.cacheRead = price;
          }
        }
        if (
          pool.inputCacheWrite != null ||
          pool.output != null ||
          pool.cacheRead != null
        ) {
          autoPool = pool;
        }
      }

      /*
       * Markdown may use Model | Provider | … — hydrated DOM often uses Name | Input | …
       */
      const legacyModelGrid =
        joined.includes("model") &&
        (joined.includes("input") || joined.includes("cache"));
      const nameRateGrid =
        joined.includes("name") &&
        joined.includes("input") &&
        (joined.includes("output") || joined.includes("cache"));

      if (legacyModelGrid || nameRateGrid) {
        const map = {};
        headerCells.forEach((h, i) => {
          if (/\\bmodels?\\b/i.test(h) && map.model == null) map.model = i;
          else if (h === "name" && map.name == null) map.name = i;
          else if (/\\binput\\b/i.test(h) && !/cache/i.test(h)) map.input = i;
          else if (/cache/i.test(h) && /write/i.test(h)) map.cacheWrite = i;
          else if (/cache/i.test(h) && /read/i.test(h)) map.cacheRead = i;
          else if (/\\boutput\\b/i.test(h)) map.output = i;
        });

        const legacyOk =
          map.model != null && map.input != null && map.output != null;
        const nameOk =
          map.name != null && map.input != null && map.output != null;

        if (legacyOk || nameOk) {
          const bodyRows = Array.from(table.querySelectorAll("tbody tr"));
          const parsed = [];
          const idxMax = Math.max(
            map.model != null ? map.model : -1,
            map.name != null ? map.name : -1,
            map.input != null ? map.input : -1,
            map.output != null ? map.output : -1,
            map.cacheWrite != null ? map.cacheWrite : -1,
            map.cacheRead != null ? map.cacheRead : -1,
          );
          for (const tr of bodyRows) {
            const cells = Array.from(tr.querySelectorAll("td"));
            if (cells.length <= idxMax) continue;
            let model = "";
            if (legacyOk) {
              model =
                cells[map.model].innerText.trim().replace(/\\s+/g, " ") || "";
              if (!model) continue;
            } else {
              model =
                cells[map.name].innerText.trim().replace(/\\s+/g, " ") || "";
              if (!model) continue;
            }
            const cw =
              map.cacheWrite != null ? parseUsd(cells[map.cacheWrite]) : null;
            parsed.push({
              model,
              input: parseUsd(cells[map.input]),
              cacheWrite: cw,
              cacheRead:
                map.cacheRead != null ? parseUsd(cells[map.cacheRead]) : null,
              output: parseUsd(cells[map.output]),
            });
          }
          lastParsedLen = parsed.length;
          if (
            parsed.length >= MIN_ROWS &&
            (!models || parsed.length > models.length)
          ) {
            models = parsed;
          }
        }
      }
    }

    if (models && models.length >= MIN_ROWS) {
      return {
        ok: true,
        autoPoolUsdPerMillion: autoPool,
        models,
      };
    }

    await new Promise((r) => setTimeout(r, 280));
  }

  const dbg = tableDebugSnapshot();
  return {
    ok: false,
    error: "pricing_tables_not_found",
    debug: {
      ...dbg,
      lastParsedModelRows: lastParsedLen,
      locationHref: typeof location !== "undefined" ? location.href : "",
    },
  };
})()`;

/**
 * @returns {Promise<{ ok: boolean, autoPoolUsdPerMillion?: object, models?: unknown[], error?: string, debug?: Record<string, unknown> }>}
 */
async function scrapePricingTablesFromDocs() {
  const t0 = Date.now();
  logInfo("opening hidden window for", PRICING_DOCS_URL);
  const win = new BrowserWindow({
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  try {
    await Promise.race([
      win.loadURL(PRICING_DOCS_URL),
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error("pricing_docs_load_timeout")), LOAD_TIMEOUT_MS);
      }),
    ]);
    logInfo("loadURL finished in", Date.now() - t0, "ms");
    await new Promise((r) => setTimeout(r, 400));
    /** @type {unknown} */
    const out = await Promise.race([
      win.webContents.executeJavaScript(SCRAPER_SCRIPT),
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error("pricing_scrape_js_timeout")), LOAD_TIMEOUT_MS + 5000);
      }),
    ]);
    if (!out || typeof out !== "object") {
      logErr("scrape returned non-object:", typeof out);
      return { ok: false, error: "bad_scrape_result", debug: { typeofOut: typeof out } };
    }
    const o = /** @type {Record<string, unknown>} */ (out);
    if (!o.ok) {
      const err = typeof o.error === "string" ? o.error : "scrape_failed";
      let dbgStr = "";
      try {
        dbgStr =
          o.debug && typeof o.debug === "object"
            ? JSON.stringify(o.debug, null, 2)
            : String(o.debug || "");
      } catch {
        dbgStr = "(debug stringify failed)";
      }
      logErr("scrape reported failure:", err, "debug=", dbgStr || o.debug);
      return { ok: false, error: err, debug: o.debug && typeof o.debug === "object" ? o.debug : undefined };
    }
    const models = o.models;
    if (!Array.isArray(models) || models.length < MIN_MODEL_ROWS) {
      logErr(
        "too few models parsed:",
        Array.isArray(models) ? models.length : "not-array",
        "(min",
        MIN_MODEL_ROWS + ")",
      );
      return {
        ok: false,
        error: "too_few_models",
        debug: { modelCount: Array.isArray(models) ? models.length : null },
      };
    }
    logInfo("scrape OK:", models.length, "models in", Date.now() - t0, "ms total");
    return {
      ok: true,
      autoPoolUsdPerMillion:
        o.autoPoolUsdPerMillion && typeof o.autoPoolUsdPerMillion === "object"
          ? o.autoPoolUsdPerMillion
          : undefined,
      models,
    };
  } catch (e) {
    logErr("scrape threw:", e instanceof Error ? e.message : String(e));
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    };
  } finally {
    if (!win.isDestroyed()) {
      try {
        win.destroy();
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * @param {unknown[]} scrapedModels
 * @param {{ autoPoolUsdPerMillion?: object }} scrapedExtras
 */
function buildPricingPayload(scrapedModels, scrapedExtras) {
  const ap = scrapedExtras.autoPoolUsdPerMillion;
  const autoPoolUsdPerMillion =
    ap && typeof ap === "object"
      ? {
          inputCacheWrite:
            /** @type {{ inputCacheWrite?: number | null }} */ (ap).inputCacheWrite ?? null,
          output: /** @type {{ output?: number | null }} */ (ap).output ?? null,
          cacheRead: /** @type {{ cacheRead?: number | null }} */ (ap).cacheRead ?? null,
        }
      : {
          inputCacheWrite: null,
          output: null,
          cacheRead: null,
        };

  return {
    sourceUrl: `${POOLS_DOC_URL}#model-pricing`,
    usagePoolsUrl: POOLS_DOC_URL,
    autoPoolUsdPerMillion,
    models: scrapedModels,
  };
}

async function runResolve() {
  const now = Date.now();
  logInfo("scraping docs (no cache)");
  const scraped = await scrapePricingTablesFromDocs();
  if (scraped.ok && scraped.models) {
    const payload = buildPricingPayload(scraped.models, {
      autoPoolUsdPerMillion: scraped.autoPoolUsdPerMillion,
    });
    return {
      ok: true,
      data: payload,
      meta: { source: "live", fetchedAt: now },
    };
  }

  try {
    logErr(
      "scrape failed:",
      scraped.error,
      scraped.debug ? JSON.stringify(scraped.debug, null, 2) : "",
    );
  } catch {
    logErr("scrape failed:", scraped.error);
  }
  return {
    ok: false,
    error: scraped.error || "pricing_unavailable",
    meta: {
      scrapeError: scraped.error,
      scrapeDebug: scraped.debug,
    },
  };
}

/**
 * @param {{ forceRefresh?: boolean }} [options]
 * @returns {Promise<{ ok: boolean, data?: Record<string, unknown>, error?: string, meta?: Record<string, unknown> }>}
 */
async function resolveModelPricing(options = {}) {
  const forceRefresh = Boolean(options.forceRefresh);
  if (resolveInflight && !forceRefresh) {
    logInfo("joining in-flight scrape (deduped)");
    return resolveInflight;
  }
  const p = runResolve().finally(() => {
    if (resolveInflight === p) resolveInflight = null;
  });
  if (!forceRefresh) resolveInflight = p;
  return p;
}

/** Empty snapshot when scrape data is unavailable for sync augmentation callers. */
function getPricingSnapshotSync() {
  return { models: [] };
}

module.exports = {
  PRICING_DOCS_URL,
  POOLS_DOC_URL,
  resolveModelPricing,
  getPricingSnapshotSync,
  removeLegacyDiskCacheFile,
};
