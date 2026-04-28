/**
 * Parse `POST /api/dashboard/get-current-period-usage` JSON for on-demand spend (USD).
 * @see docs/ARCHITECTURE.md
 *
 * Cursor returns integer cents in nested objects, e.g.:
 * - `spendLimitUsage` — pay-as-you-go / per-user limit (on-demand) spend
 * - `planUsage` — included pool; amounts are cents
 *
 * @param {unknown} json
 * @returns {{
 *   amountUsd: number | null,
 *   usedUsd: number | null,
 *   limitUsd: number | null,
 *   remainingUsd: number | null,
 * }}
 */
function coalesceNumber(...vals) {
  for (const v of vals) {
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    if (v < 0) continue;
    return v;
  }
  return null;
}

function toUsd(n, { likelyCents } = { likelyCents: false }) {
  if (n == null || !Number.isFinite(n)) return null;
  if (likelyCents) return n / 100;
  /* Heuristic: large integers may be micro-cents; avoid mis-scaling small decimals */
  if (n >= 1e6 && n === Math.floor(n)) return n / 1e6;
  if (n >= 1e4 && n === Math.floor(n) && n % 100 === 0) return n / 100;
  return n;
}

function readNestedOnDemand(od) {
  if (!od || typeof od !== "object" || Array.isArray(od)) return null;
  const cents = coalesceNumber(od.cents, od.totalCents, od.amountCents);
  if (cents != null && cents > 0) {
    return toUsd(cents, { likelyCents: true });
  }
  return toUsd(
    coalesceNumber(
      od.totalUsd,
      od.usd,
      od.amountUsd,
      od.spend,
      od.total,
      od.amount,
      od.cost,
      od.dollars,
      od.charge,
    ),
  );
}

/**
 * Pay-as-you-go / per-user spend limit from dashboard API — amounts are integer cents.
 * @param {object} root
 * @returns {{ usedUsd: number, limitUsd: number | null, usedCents: number, limitCents: number | null } | null}
 */
function parseSpendLimitUsage(root) {
  if (!root || typeof root !== "object" || Array.isArray(root)) return null;
  const sl = root.spendLimitUsage;
  if (!sl || typeof sl !== "object" || Array.isArray(sl)) return null;
  const usedCents = coalesceNumber(
    sl.individualUsed,
    sl.individualSpent,
    sl.totalSpend,
    sl.userSpend,
  );
  if (usedCents == null) return null;
  const limitCents = coalesceNumber(sl.individualLimit, sl.spendLimit, sl.limit, sl.userLimit);
  const threshold =
    typeof root.displayThreshold === "number" && root.displayThreshold > 0
      ? root.displayThreshold
      : 0;
  if (usedCents < threshold) return null;
  const usedUsd = usedCents / 100;
  const limitUsd = limitCents != null ? limitCents / 100 : null;
  return { usedUsd, limitUsd, usedCents, limitCents };
}

function tryRoot(root) {
  if (!root || typeof root !== "object" || Array.isArray(root)) return null;

  const direct = toUsd(
    coalesceNumber(
      root.onDemandSpend,
      root.onDemandTotal,
      root.onDemandAmount,
      root.onDemandUsd,
      root.totalOnDemandSpend,
      root.usageBasedSpend,
      root.usageBasedCost,
      root.paygSpend,
      root.overageAmount,
    ),
  );
  if (direct != null && direct > 0) return direct;

  const odRef = root.onDemand ?? root.on_demand ?? root.onDemandUsage ?? root.ondemand;
  if (typeof odRef === "number" && odRef > 0) {
    return toUsd(odRef);
  }
  const nested = readNestedOnDemand(odRef);
  if (nested != null && nested > 0) return nested;

  return null;
}

/**
 * @param {unknown} obj
 * @param {number} depth
 * @returns {number | null}
 */
function walkOnDemandMoney(obj, depth) {
  if (depth > 14 || obj == null) return null;
  if (typeof obj !== "object") return null;

  if (Array.isArray(obj)) {
    for (const item of obj) {
      const f = walkOnDemandMoney(item, depth + 1);
      if (f != null && f > 0) return f;
    }
    return null;
  }

  for (const [k, v] of Object.entries(obj)) {
    const kl = k.toLowerCase();
    if (typeof v === "number" && Number.isFinite(v) && v > 0) {
      const isOnDemandKey =
        kl.includes("ondemand") || kl.includes("on_demand") || kl === "usagebased" || kl.includes("payg");
      const isMoneyKey =
        kl.includes("spend") ||
        kl.includes("cost") ||
        kl.includes("amount") ||
        kl.includes("usd") ||
        kl.includes("dollar") ||
        kl.includes("total") ||
        kl.includes("charge") ||
        kl.includes("billed");
      if (isOnDemandKey && isMoneyKey && !kl.includes("token") && !kl.includes("percent") && !kl.includes("pct")) {
        const likelyCents = kl.includes("cent");
        const u = toUsd(v, { likelyCents });
        if (u != null && u > 0 && u < 1e7) return u;
      }
    } else if (v && typeof v === "object") {
      if (kl.includes("ondemand") || kl.includes("on_demand") || kl.includes("usagebased")) {
        const inner = walkOnDemandMoney(v, depth + 1);
        if (inner != null && inner > 0) return inner;
      }
    }
  }

  for (const v of Object.values(obj)) {
    if (v && typeof v === "object") {
      const inner = walkOnDemandMoney(v, depth + 1);
      if (inner != null && inner > 0) return inner;
    }
  }
  return null;
}

function emptyUsage() {
  return {
    amountUsd: null,
    usedUsd: null,
    limitUsd: null,
    remainingUsd: null,
  };
}

function wrapSingleUsd(amountUsd) {
  return {
    amountUsd,
    usedUsd: amountUsd,
    limitUsd: null,
    remainingUsd: null,
  };
}

function parseCurrentPeriodUsage(json) {
  if (json == null) return emptyUsage();

  let root = json;
  if (typeof root === "object" && !Array.isArray(root) && root.data && typeof root.data === "object") {
    const fromSl = parseSpendLimitUsage(root.data);
    if (fromSl != null) {
      const remainingUsd =
        fromSl.limitCents != null
          ? (fromSl.limitCents - fromSl.usedCents) / 100
          : null;
      return {
        amountUsd: fromSl.usedUsd,
        usedUsd: fromSl.usedUsd,
        limitUsd: fromSl.limitUsd,
        remainingUsd,
      };
    }
    const fromData = tryRoot(root.data);
    if (fromData != null) return wrapSingleUsd(fromData);
  }

  if (typeof root === "object" && !Array.isArray(root)) {
    const fromSl = parseSpendLimitUsage(root);
    if (fromSl != null) {
      const remainingUsd =
        fromSl.limitCents != null
          ? (fromSl.limitCents - fromSl.usedCents) / 100
          : null;
      return {
        amountUsd: fromSl.usedUsd,
        usedUsd: fromSl.usedUsd,
        limitUsd: fromSl.limitUsd,
        remainingUsd,
      };
    }
  }

  const top = tryRoot(root);
  if (top != null) return wrapSingleUsd(top);

  const w = walkOnDemandMoney(root, 0);
  if (w != null) return wrapSingleUsd(w);

  return emptyUsage();
}

module.exports = { parseCurrentPeriodUsage };
