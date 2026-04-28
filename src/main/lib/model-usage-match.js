/**
 * Map Cursor dashboard {@link https://cursor.com/api/dashboard/get-aggregated-usage-events}
 * `modelIntent` strings onto display labels from the same model names as Cursor docs pricing
 * ({@link ./model-pricing-fetch.js} live docs scrape).
 *
 * Uses max-score wins per aggregation row so each intent counts once toward the closest model row.
 */

/**
 * @param {unknown} v
 * @returns {number}
 */
function num(v) {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

/** API field `totalCents` is fractional cents-style units; divide by 100 for USD spend. */
function centsFieldToUsd(v) {
  return num(v) / 100;
}

/** @typedef {{ model: string }} PricingRowLike */

/** @param {unknown} raw */
function parseAggregations(raw) {
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.aggregations)) {
    return {
      list: [],
      totalCostUsd: typeof raw === "object" ? centsFieldToUsd(raw.totalCostCents) : 0,
    };
  }
  const list = raw.aggregations.map((row) => {
    if (!row || typeof row !== "object") {
      return { modelIntent: "", totalUsd: 0 };
    }
    const o = /** @type {Record<string, unknown>} */ (row);
    return {
      modelIntent: typeof o.modelIntent === "string" ? o.modelIntent : "",
      totalUsd: centsFieldToUsd(o.totalCents),
    };
  });
  return { list, totalCostUsd: centsFieldToUsd(raw.totalCostCents) };
}

/**
 * @param {string} displayName
 * @returns {{ major: number, minor: number | null } | null}
 */
function parseLeadingVersion(displayName) {
  const m = displayName.match(/^[^\d]*([\d.]+)/);
  if (!m) return null;
  const parts = m[1].split(".").map((p) => parseInt(p, 10));
  if (!parts.length || !Number.isFinite(parts[0])) return null;
  return { major: parts[0], minor: parts.length > 1 && Number.isFinite(parts[1]) ? parts[1] : null };
}

/**
 * @param {number} major
 * @param {number | null} minor
 * @param {string} i
 */
function intentHasGptVersion(major, minor, i) {
  const low = i.toLowerCase();
  if (minor != null) {
    return (
      low.includes(`${major}.${minor}`) ||
      low.includes(`${major}-${minor}`) ||
      low.includes(`${major}_${minor}`)
    );
  }
  /** Display "GPT-5" only — forbid gpt-5.1 … gpt-5.99 style when we want bare major line */
  if (new RegExp(`gpt[.-]${major}\\.\\d`, "i").test(low)) return false;
  if (new RegExp(`gpt[.-]${major}-\\d`, "i").test(low)) return false;
  return new RegExp(`gpt[.-]${major}(?:[^0-9.\-]|$)`, "i").test(low) || new RegExp(`gpt-${major}\\b`, "i").test(low);
}

/** @param {string} tier */
function claudeTierInIntent(i, tier) {
  const t = tier.toLowerCase();
  if (t === "opus") return /\bopus\b/.test(i) && !/\bsonnet\b/.test(i); /* avoid "song" typos … */
  if (t === "sonnet") return /\bsonnet\b/.test(i);
  if (t === "haiku") return /\bhaiku\b/.test(i);
  return false;
}

/** @param {string} tier */
function claudeTierInIntentLoose(i, tier) {
  const t = tier.toLowerCase();
  return t === "opus" ? /\bopus\b/.test(i) : t === "sonnet" ? /\bsonnet\b/.test(i) : /\bhaiku\b/.test(i);
}

/**
 * @param {string} name
 * @param {string} intent
 */
function scoreClaude(name, intent) {
  const i = intent;
  if (!/^claude/i.test(name) || !/\bclaude\b/.test(i)) return 0;
  const m = name.match(/^Claude\s+([\d.]+)\s+/i);
  if (!m) return 0;
  const pv = parseLeadingVersion(name.slice(name.indexOf(m[1])));
  const major = pv?.major;
  const minor = pv?.minor;
  if (major == null) return 0;
  let tier = "";
  const rest = name.slice(name.indexOf(m[1]) + m[1].length).trim();
  const tm = rest.match(/^(opus|sonnet|haiku)\b/i);
  if (tm) tier = tm[1].toLowerCase();
  if (!tier) return 0;

  /** "Claude 4 Sonnet", "Claude 4 Sonnet 1M" — single-major only */
  const singleMajorOnly = minor == null && /^\s*(opus|sonnet|haiku)\b/i.test(rest);

  if (tier === "opus" || tier === "sonnet" || tier === "haiku") {
    if (!claudeTierInIntentLoose(i, tier)) return 0;
  }

  if (minor != null) {
    const okVer =
      i.includes(`${major}-${minor}-${tier}`) ||
      i.includes(`${major}.${minor}`) ||
      i.includes(`${major}_${minor}`) ||
      i.includes(`${tier}-${major}-${minor}`) ||
      i.includes(`${major}-${minor}-`);

    /** e.g. claude-opus-4-7-thinking */
    const alt =
      i.includes(`${major}-${minor}-`) ||
      i.includes(`${tier}-${major}-${minor}`) ||
      i.includes(`-${major}-${minor}-`);

    const verOk =
      okVer ||
      alt ||
      (i.includes(`-${major}-${minor}-`) &&
        /\bthinking\b|\b(high|medium|low)\b/.test(i) &&
        claudeTierInIntentLoose(i, tier));

    if (!verOk) return 0;
    let s = 200;
    if (/\bfast\b/.test(name.toLowerCase()) && /\bfast\b/.test(i)) s += 50;
    if (/\bpremium\b|\b1m\b/i.test(name) && (/\bpremium\b/i.test(i) || i.includes("1m"))) s += 20;
    return s;
  }

  if (!singleMajorOnly) return 0;

  /** Claude 4 only line: disallow if intent clearly encodes minor (4–5 vs 4) */
  if (i.includes(`${major}-${major + 1}`)) return 0;

  /** If intent lists two-part version …-4-5-, don't match Claude 4 (single-major) Sonnet row */
  const twoPart = i.match(/\b(?:claude|opus|sonnet|haiku|-)(\d+)-(\d+)-(?:opus|sonnet|haiku|thinking)/);
  if (twoPart && twoPart[1] === String(major) && twoPart[2] !== String(major)) return 0;

  const hasMinor =
    new RegExp(`(?:^|-)${major}-(?!0\\b)(\\d+)-`, "i").test(i) &&
    !i.includes(`${major}-0-`) &&
    !new RegExp(`${major}-(?:sonnet|opus|haiku)\\b`, "i").test(i);

  if (hasMinor) {
    const strict = new RegExp(`(^|-)${major}-(?:sonnet|opus|haiku)\\b`, "i");
    if (!strict.test(i)) return 0;
  }

  if (!claudeTierInIntent(i, tier)) return 0;
  let s = 120;
  if (/\bfast\b/.test(name.toLowerCase()) && /\bfast\b/.test(i)) s += 50;
  if (/\bpremium\b|\b1m\b/i.test(name) && (/\b1m\b/i.test(i) || i.includes("1m"))) s += 30;
  return s;
}

/**
 * @param {string} name
 * @param {string} intent
 */
function scoreComposer(name, intent) {
  const i = intent.toLowerCase();
  if (!/^Composer\s/i.test(name) || !i.includes("composer")) return 0;
  const m = name.match(/^Composer\s+([\d.]+)/i);
  if (!m) return 0;
  const segs = m[1].split(".").map((x) => parseInt(x, 10)).filter(Number.isFinite);
  if (!segs.length) return 0;

  if (segs.length >= 2) {
    const [a, b] = segs;
    if (!i.includes(`composer-${a}-${b}`) && !i.includes(`composer-${a}.${b}`)) return 0;
  } else {
    const v = segs[0];
    /** `composer-1` must not absorb `composer-1-5` */
    if (v === 1 && /\bcomposer-1-5\b/.test(i)) return 0;
    const base = new RegExp(`composer-${v}(?:-[a-z]|$)`, "i");
    if (!base.test(i) && !i.includes(`composer-${v}-`)) return 0;
  }

  const wantFast = /\((Fast mode)\)/i.test(name) || /\bFast\b/i.test(name);
  let s = 180;
  if (wantFast) {
    if (/\bfast\b/.test(i)) s += 60;
    else s -= 40;
  } else if (/\bfast\b/.test(i)) {
    s += 20;
  }
  return s;
}

/**
 * @param {string} name
 * @param {string} intent
 */
function scoreGpt(name, intent) {
  const i = intent.toLowerCase();
  if (!/^GPT/i.test(name) || !/\bgpt\b/.test(i)) return 0;

  const wantCodex = /\bcodex\b/i.test(name);
  const wantMini = /\bmini\b/i.test(name);
  const wantNano = /\bnano\b/i.test(name);
  const wantMax = /\bmax\b/i.test(name);
  const wantFast = /\bFast\b/.test(name) && !wantMini;

  if (wantCodex && !/\bcodex\b/.test(i)) return 0;
  if (!wantCodex && /\bcodex\b/.test(i) && !/\bnon-codex\b/.test(i)) {
    if (!/\bGPT[^\n]*Codex\b/i.test(name)) return 0;
  }

  if (wantMini) {
    if (!/\bmini\b/.test(i)) return 0;
  } else if (wantNano) {
    if (!/\bnano\b/.test(i)) return 0;
  } else if (wantMax) {
    if (!/\bmax\b/.test(i)) return 0;
  } else if (/\bmini\b/.test(i) && !wantMini) {
    if (!/\bMini\b/.test(name)) return 0;
  } else if (/\bnano\b/.test(i) && !wantNano) {
    if (!/\bNano\b/.test(name)) return 0;
  }

  const pv = parseLeadingVersion(name.replace(/^GPT-?/i, ""));
  if (!pv) return /\bgpt-5\b/i.test(name) ? (/\bgpt-5\b/.test(i) && !/\b5\.\d/.test(i) ? 100 : 0) : 0;

  const { major, minor } = pv;
  if (minor != null) {
    if (!intentHasGptVersion(major, minor, i)) return 0;
  } else {
    if (!intentHasGptVersion(major, null, i)) return 0;
  }

  let s = 200;
  if (wantFast && /\bfast\b/.test(i)) s += 40;
  return s;
}

/**
 * @param {string} name
 * @param {string} intent
 */
function scoreGemini(name, intent) {
  const i = intent.toLowerCase();
  if (!/^Gemini/i.test(name) || !/\bgemini\b/.test(i)) return 0;
  const nim = i;

  const ver = parseLeadingVersion(name.replace(/^Gemini\s*/i, ""));
  if (ver?.minor != null) {
    if (!nim.includes(`${ver.major}.${ver.minor}`) && !nim.includes(`${ver.major}-${ver.minor}`)) return 0;
  } else if (ver) {
    if (!nim.includes(`gemini-${ver.major}`) && !nim.includes(`gemini${ver.major}`)) return 0;
  }

  if (/\bflash\b/i.test(name) && !/\bflash\b/.test(i)) return 0;
  /** Pro tier rows (excluding "Flash") */
  if (/\bpro\b/i.test(name) && !/\bflash\b/i.test(name)) {
    if (!/\bpro\b/.test(i) || /\bflash\b/.test(i)) return 0;
  }
  if (/\bimage\b/i.test(name) && !/\bimage\b/.test(i)) return 0;
  return 190;
}

/**
 * @param {string} name
 * @param {string} intent
 */
function scoreGrok(name, intent) {
  const i = intent;
  if (!/^Grok/i.test(name) || !/\bgrok\b/.test(i)) return 0;
  const ver = parseLeadingVersion(name.replace(/^Grok\s*/i, ""));
  if (!ver || ver.minor == null) return 0;
  return i.includes(`${ver.major}.${ver.minor}`) || i.includes(`${ver.major}-${ver.minor}`) ? 180 : 0;
}

/**
 * @param {string} name
 * @param {string} intent
 */
function scoreKimi(name, intent) {
  const i = intent;
  if (!/^Kimi/i.test(name) || !/kimi|k2/i.test(i)) return 0;
  const ver = parseLeadingVersion(name.replace(/^Kimi\s*K/i, ""));
  if (!ver) return 0;
  return i.includes(`${ver.major}.${ver.minor}`) || i.includes(`${ver.major}-${ver.minor}`) ? 180 : 0;
}

/**
 * @param {string} displayName
 * @param {string} modelIntent
 */
function scoreIntentForModel(displayName, modelIntent) {
  const name = displayName.trim();
  const intent = modelIntent.toLowerCase();
  if (!name || !intent) return 0;

  if (intent === "premium" || intent === "default") return 0;

  if (/^Claude/i.test(name)) return scoreClaude(name, intent);
  if (/^Composer/i.test(name)) return scoreComposer(name, intent);
  if (/^GPT/i.test(name)) return scoreGpt(name, intent);
  if (/^Gemini/i.test(name)) return scoreGemini(name, intent);
  if (/^Grok/i.test(name)) return scoreGrok(name, intent);
  if (/^Kimi/i.test(name)) return scoreKimi(name, intent);
  return 0;
}

/**
 * @param {PricingRowLike[]} models
 * @param {Array<{ modelIntent: string, totalUsd: number }>} aggregations
 * @returns {{
 *   modelUsd: number[],
 *   autoUsd: number,
 *   orphanedUsd: number,
 *   totalsReportedUsd: number,
 * }}
 */
function assignAggregationToPricingRows(models, aggregations) {
  const modelUsd = models.map(() => 0);
  let orphanedUsd = 0;

  for (let a = 0; a < aggregations.length; a++) {
    const row = aggregations[a];
    const intent = row.modelIntent;
    const amt = row.totalUsd;
    if (!intent || intent === "premium" || intent === "default") {
      orphanedUsd += amt;
      continue;
    }

    let bestIdx = -1;
    let bestScore = 0;
    let bestLen = 0;

    for (let i = 0; i < models.length; i++) {
      const sc = scoreIntentForModel(models[i].model || "", intent);
      const len = String(models[i].model || "").length;
      if (
        sc > bestScore ||
        (sc === bestScore && sc > 0 && len > bestLen)
      ) {
        bestScore = sc;
        bestIdx = i;
        bestLen = len;
      }
    }

    if (bestIdx >= 0 && bestScore > 0) {
      modelUsd[bestIdx] += amt;
    } else {
      orphanedUsd += amt;
    }
  }

  return { modelUsd, orphanedUsd };
}

/**
 * @param {{ models?: PricingRowLike[] }} pricingJsonFromDisk
 * @param {unknown} apiJson
 * @param {number | null} [periodStartMs]
 */
function buildPricingUsageAugmentation(pricingJsonFromDisk, apiJson, periodStartMs = null) {
  const models = Array.isArray(pricingJsonFromDisk?.models) ? pricingJsonFromDisk.models : [];
  const { list, totalCostUsd } = parseAggregations(apiJson);

  const { modelUsd, orphanedUsd } = assignAggregationToPricingRows(
    /** @type {PricingRowLike[]} */ (models),
    list,
  );

  const autoPoolUsd = orphanedUsd;
  const totalAlignedUsd = modelUsd.reduce((s, x) => s + x, 0) + autoPoolUsd;

  return {
    ok: true,
    totalCostUsd,
    totalAlignedUsd,
    modelUsd,
    autoPoolUsd,
    periodStartMs,
    rawError: null,
  };
}

/**
 * @param {{ models?: PricingRowLike[] }} pricingJsonFromDisk
 * @param {string | null} errorText
 * @param {number | null} [periodStartMs]
 */
function buildUsageError(pricingJsonFromDisk, errorText, periodStartMs = null) {
  const n = Array.isArray(pricingJsonFromDisk?.models) ? pricingJsonFromDisk.models.length : 0;
  return {
    ok: false,
    totalCostUsd: null,
    totalAlignedUsd: null,
    modelUsd: new Array(n).fill(null),
    autoPoolUsd: null,
    periodStartMs,
    rawError: errorText,
  };
}

module.exports = {
  buildPricingUsageAugmentation,
  buildUsageError,
  scoreIntentForModel,
  parseAggregations,
};
