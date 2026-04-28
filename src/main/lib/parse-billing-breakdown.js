/**
 * Extract Auto vs API usage breakdown slices from Cursor billing dashboard __NEXT_DATA__.
 * See https://cursor.com/dashboard/billing — per-model rows with tokens and % of pool.
 * @see docs/ARCHITECTURE.md
 */

const MAX_PIE_SLICES = 10;

/** Section totals on the billing table — not individual product lines (e.g. a row named "auto" must stay). */
const POOL_TOTAL_RE = /^(api|auto\s*\+\s*composer|auto\+composer|included usage)$/i;

const API_KEY_RE =
  /^(api|apiPool|apiUsage|apiBreakdown|apiRows|apiLine|apiLines|apiline)$/i;
const AUTO_KEY_RE =
  /^(auto|autoComposer|autoAndComposer|autoPlusComposer|composer|inApp|in_app|autoInApp|editor|editorUsage)$/i;

function numWeight(v) {
  if (v == null || v === "") return null;
  if (typeof v === "string") {
    const raw = String(v).trim();
    const asPctString = /%/.test(raw);
    const t = raw.replace(/%/g, "");
    const n = parseFloat(String(t).replace(/,/g, ""));
    if (!Number.isFinite(n)) return null;
    if (asPctString) return Math.max(0, n);
    v = n;
  }
  if (Number.isNaN(Number(v))) return null;
  let n = Number(v);
  /*
   * Billing UI often uses 0.2 (meaning 0.2%) next to 39.9 (39.9%). Do not re-scale the smalls.
   * Keep [0.5, 1] as unit fractions (e.g. 0.5 → 50%, 0.99 → 99%).
   */
  if (n > 0.5 && n <= 1) n *= 100;
  return Math.max(0, n);
}

function formatTokenShort(n) {
  if (n == null || !Number.isFinite(Number(n))) return null;
  const v = Math.abs(Number(n));
  if (v >= 1e12) return (n / 1e12).toFixed(1).replace(/\.0$/, "") + "T";
  if (v >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, "") + "B";
  if (v >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
  if (v >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, "") + "K";
  if (v >= 1) return String(Math.round(v));
  return n.toString();
}

function extractTokensText(item) {
  if (!item || typeof item !== "object") return null;
  const fromStr =
    item.tokensText ??
    item.tokensLabel ??
    item.formattedTokens ??
    item.tokenDisplay ??
    item.displayTokens;
  if (typeof fromStr === "string" && fromStr.trim()) {
    const t = fromStr.trim();
    if (/\b(tok|token)/i.test(t)) return t;
    return t + (/\d/.test(t) ? " tok" : "");
  }
  const n =
    item.tokens ??
    item.totalTokens ??
    (typeof item.inputTokens === "number" && typeof item.outputTokens === "number"
      ? item.inputTokens + item.outputTokens
      : null);
  if (typeof n === "number" && Number.isFinite(n) && n > 0) {
    const s = formatTokenShort(n);
    return s ? s + " tok" : null;
  }
  return null;
}

function weightFromNested(item) {
  const nested = item.usage || item.stats || item.metrics || item.breakdown;
  if (!nested || typeof nested !== "object") return null;
  return (
    numWeight(nested.percent) ??
    numWeight(nested.percentage) ??
    numWeight(nested.usagePercent) ??
    numWeight(nested.pct) ??
    null
  );
}

function normalizeItem(item) {
  if (!item || typeof item !== "object") return null;
  const label = String(
    item.name ??
      item.label ??
      item.title ??
      item.model ??
      item.modelName ??
      item.modelId ??
      item.key ??
      item.type ??
      item.category ??
      item.id ??
      "?",
  ).slice(0, 80);

  let weight =
    numWeight(item.percent) ??
    numWeight(item.percentUsed) ??
    numWeight(item.linePercent) ??
    numWeight(item.ofPool) ??
    numWeight(item.usagePercent) ??
    numWeight(item.usagePercentage) ??
    numWeight(item.percentage) ??
    numWeight(item.pct) ??
    numWeight(item.share) ??
    numWeight(item.ratio) ??
    numWeight(item.amountPercent) ??
    numWeight(item.usedPercent) ??
    numWeight(item.part) ??
    weightFromNested(item);

  if (weight == null) {
    const c =
      item.cost ??
      item.amount ??
      item.costUsd ??
      item.usd ??
      item.total ??
      item.spend ??
      item.price;
    if (c != null && c !== "") weight = Math.abs(Number(String(c).replace(/,/g, "")));
  }
  if (weight == null) {
    const t =
      item.tokens ?? item.totalTokens ?? (item.inputTokens || 0) + (item.outputTokens || 0);
    if (typeof t === "number" && Number.isFinite(t) && t > 0) weight = t;
  }
  if (weight == null || weight === 0) return null;
  const tokensText = extractTokensText(item);
  return { label, weight, tokensText };
}

function isPoolTotalLabel(lab) {
  return POOL_TOTAL_RE.test(String(lab).trim());
}

function filterOutPoolTotals(slices) {
  if (!slices || slices.length < 2) return slices || [];
  const hasModels = slices.some((s) => !isPoolTotalLabel(s.label));
  if (!hasModels) return slices;
  return slices.filter((s) => !isPoolTotalLabel(s.label));
}

function isGenericUsedRemaining(slices) {
  if (!slices || slices.length !== 2) return false;
  const labs = slices.map((s) => s.label.toLowerCase());
  return labs.includes("used") && labs.includes("remaining");
}

function pathScores(path) {
  const p = path.toLowerCase();
  let api = 0;
  let auto = 0;
  if (/\bapi\b/.test(p) || p.includes("apipool") || p.includes("api_")) api += 4;
  if (p.includes("autocomposer") || p.includes("auto_composer") || p.includes("auto+composer")) auto += 6;
  else if (/\bcomposer\b/.test(p) && !/\bapicomposer\b/.test(p)) auto += 3;
  if (p.includes("auto") && p.includes("composer")) auto += 2;
  if (p.includes("inapp") || p.includes("in_app") || p.includes("ineditor") || p.includes("in_editor")) auto += 2;
  if (p.includes("breakdown") || p.includes("permodel") || p.includes("by_model") || p.includes("usage")) {
    api += 1;
    auto += 1;
  }
  if (p.includes("pool") && p.includes("api")) api += 1;
  return { api, auto };
}

function capSlices(slices) {
  if (slices.length <= MAX_PIE_SLICES) return slices;
  const sorted = [...slices].sort((a, b) => b.weight - a.weight);
  const top = sorted.slice(0, MAX_PIE_SLICES - 1);
  const rest = sorted.slice(MAX_PIE_SLICES - 1);
  const wOther = rest.reduce((s, x) => s + x.weight, 0);
  if (wOther > 0) top.push({ label: "Other", weight: wOther, tokensText: null });
  return top;
}

function toPieArray(c) {
  if (!c) return [];
  let slices = c.slices.map((s) => ({ ...s }));
  slices = filterOutPoolTotals(slices);
  slices = capSlices(slices);
  const sum = slices.reduce((s, x) => s + x.weight, 0);
  if (sum <= 0) return [];
  return slices.map((s) => ({
    label: s.label,
    value: s.weight / sum,
    weight: s.weight,
    tokensText: s.tokensText || null,
  }));
}

function collectCandidateArrays(obj, path, depth, out) {
  if (depth > 14 || obj == null) return;
  if (Array.isArray(obj)) {
    if (obj.length >= 1 && typeof obj[0] === "object") {
      const raw = obj.map(normalizeItem).filter(Boolean);
      const slices = filterOutPoolTotals(raw);
      const use = slices.length >= 1 ? slices : raw;
      if (use.length >= 1) {
        out.push({ path, slices: use, len: obj.length, rawCount: raw.length });
      }
    }
    for (let i = 0; i < Math.min(obj.length, 8); i++) {
      collectCandidateArrays(obj[i], `${path}[${i}]`, depth + 1, out);
    }
    return;
  }
  if (typeof obj === "object") {
    for (const [k, v] of Object.entries(obj)) {
      collectCandidateArrays(v, `${path}.${k}`, depth + 1, out);
    }
  }
}

function findDirectApiAutoArrays(obj, depth) {
  if (depth > 10 || !obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  const keys = Object.keys(obj);
  const apiKey = keys.find(
    (k) =>
      API_KEY_RE.test(k) && Array.isArray(obj[k]) && obj[k].length > 0 && typeof obj[k][0] === "object",
  );
  const autoKey = keys.find(
    (k) =>
      AUTO_KEY_RE.test(k) && Array.isArray(obj[k]) && obj[k].length > 0 && typeof obj[k][0] === "object",
  );
  if (apiKey && autoKey) {
    return { api: obj[apiKey], auto: obj[autoKey], pathKey: "direct" };
  }
  for (const v of Object.values(obj)) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const hit = findDirectApiAutoArrays(v, depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}

function candidateFromArray(arr, path) {
  if (!Array.isArray(arr) || !arr.length) return null;
  const slices = filterOutPoolTotals(arr.map(normalizeItem).filter(Boolean));
  if (!slices.length) return null;
  return { path, slices, len: arr.length, rawCount: arr.length };
}

function pickForPool(candidates, pool, excludePath) {
  if (!candidates || !candidates.length) return null;
  const want = pool === "api" ? "api" : "auto";
  const scored = candidates
    .map((c) => {
      if (excludePath && c.path === excludePath) return { c, r: -1e8 };
      if (isGenericUsedRemaining(c.slices)) return { c, r: -1e6 };
      const { api, auto } = pathScores(c.path);
      const base = want === "api" ? api : auto;
      const rich = c.slices.filter((s) => !isPoolTotalLabel(s.label)).length;
      return { c, r: base * 200 + rich * 5 + c.slices.length * 0.1 };
    })
    .sort((a, b) => b.r - a.r);
  const best = scored.find((x) => x.r > -1e5);
  if (best) return best.c;
  const byPath = candidates
    .filter((c) => !excludePath || c.path !== excludePath)
    .map((c) => ({ c, s: pathScores(c.path) }))
    .sort((a, b) =>
      want === "api"
        ? b.s.api - a.s.api || b.c.slices.length - a.c.slices.length
        : b.s.auto - a.s.auto || b.c.slices.length - a.c.slices.length,
    );
  return byPath[0]?.c ?? null;
}

/**
 * @param {object | null} nextData
 * @returns {{ auto: object[], api: object[], candidates: object[] }}
 */
function extractBillingPies(nextData) {
  const candidates = [];
  const pageRoot = nextData?.props?.pageProps ?? nextData ?? null;

  if (pageRoot) {
    const direct = findDirectApiAutoArrays(pageRoot, 0);
    if (direct) {
      const apiC = candidateFromArray(direct.api, "pageProps.<direct:api>");
      const autoC = candidateFromArray(direct.auto, "pageProps.<direct:auto>");
      if (apiC && autoC) {
        return {
          auto: toPieArray(autoC),
          api: toPieArray(apiC),
          candidates: [
            { path: apiC.path, n: apiC.slices.length },
            { path: autoC.path, n: autoC.slices.length },
          ],
        };
      }
    }
  }

  if (nextData?.props?.pageProps) {
    collectCandidateArrays(nextData.props.pageProps, "pageProps", 0, candidates);
  } else if (nextData) {
    collectCandidateArrays(nextData, "root", 0, candidates);
  }

  const valid = candidates.filter((c) => c.slices.reduce((s, x) => s + x.weight, 0) > 0);
  if (!valid.length) {
    return { auto: [], api: [], candidates: [] };
  }

  let bestApi = pickForPool(valid, "api", null);
  let bestAuto = pickForPool(valid, "auto", bestApi ? bestApi.path : null);

  if (bestApi && !bestAuto) {
    bestAuto = valid.find((c) => c.path !== bestApi.path) ?? null;
  }
  if (bestAuto && !bestApi) {
    bestApi = valid.find((c) => c.path !== bestAuto.path) ?? null;
  }
  if (bestApi && bestAuto && bestApi.path === bestAuto.path) {
    bestApi = pickForPool(valid, "api", bestAuto.path);
  }
  if (bestApi && bestAuto && bestApi.path === bestAuto.path && valid.length > 1) {
    const alt = valid.find((c) => c.path !== bestApi.path);
    if (alt) {
      const s = pathScores(alt.path);
      if (s.api >= s.auto) bestApi = alt;
      else bestAuto = alt;
    }
  }
  if (!bestApi) {
    bestApi = valid
      .map((c) => ({ c, s: pathScores(c.path) }))
      .sort((a, b) => b.s.api - a.s.api || b.c.slices.length - a.c.slices.length)[0]?.c;
  }
  if (!bestAuto) {
    bestAuto = valid
      .map((c) => ({ c, s: pathScores(c.path) }))
      .sort((a, b) => b.s.auto - a.s.auto || b.c.slices.length - a.c.slices.length)[0]?.c;
  }
  if (bestApi && bestAuto && bestApi.path === bestAuto.path) {
    bestAuto = valid.find((c) => c.path !== bestApi.path) ?? null;
  }
  if (!bestApi) bestApi = valid[0] ?? null;
  if (!bestAuto) {
    const alt = valid.find((c) => c.path !== (bestApi && bestApi.path)) ?? null;
    bestAuto = alt ?? (valid[1] ?? null);
  }
  if (bestApi && bestAuto && bestApi.path === bestAuto.path) {
    bestAuto = valid.find((c) => c.path !== bestApi.path) ?? bestAuto;
  }

  return {
    auto: toPieArray(bestAuto),
    api: toPieArray(bestApi),
    candidates: candidates.slice(0, 12).map((c) => ({ path: c.path, n: c.slices.length })),
  };
}

module.exports = { extractBillingPies, MAX_PIE_SLICES };
