/**
 * Parse Cursor dashboard / spending page snapshot (innerText + optional __NEXT_DATA__).
 * Tolerates minor copy changes; falls back to regex on visible text.
 * @see docs/ARCHITECTURE.md
 */

function parseMoney(s) {
  const n = parseFloat(String(s).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

function walkNextData(obj, out, depth = 0) {
  if (depth > 24 || obj == null) return;
  if (typeof obj !== "object") return;

  if (Array.isArray(obj)) {
    for (const item of obj) walkNextData(item, out, depth + 1);
    return;
  }

  for (const [k, v] of Object.entries(obj)) {
    const kl = k.toLowerCase();

    if (typeof v === "number" && v >= 0 && v <= 100) {
      if (kl.includes("auto") && (kl.includes("percent") || kl.includes("pct") || kl.includes("usage"))) {
        out.autoPercent = v;
      }
      if (kl.includes("api") && (kl.includes("percent") || kl.includes("pct") || kl.includes("usage"))) {
        out.apiPercent = v;
      }
    }

    if (typeof v === "string" && v.length > 0 && v.length < 80) {
      if (kl.includes("reset") || kl.includes("billing") || kl.includes("period")) {
        const m = v.match(/(\d{1,2}\s+\w{3,9}\s+\d{2,4})/i);
        if (m) out.resetLabel = out.resetLabel || m[1];
        const iso = v.match(/\b(\d{4}-\d{2}-\d{2})\b/);
        if (iso) out.resetLabel = out.resetLabel || iso[1];
      }
    }

    walkNextData(v, out, depth + 1);
  }
}

/**
 * @param {{ text: string, nextData: object | null, title: string, url: string, accountAvatarUrl?: string | null }} snapshot
 * @returns {{
 *   ok: boolean,
 *   loggedIn: boolean | null,
 *   resetLabel: string | null,
 *   resetRelative: string | null,
 *   autoPercent: number | null,
 *   apiPercent: number | null,
 *   onDemand: { used: number, limit: number } | null,
 *   note: string | null,
 *   title: string,
 *   url: string,
 *   accountAvatarUrl: string | null
 * }}
 */
function parseSpendingSnapshot(snapshot) {
  const text = snapshot.text || "";
  const title = snapshot.title || "";
  const url = snapshot.url || "";

  const out = {
    ok: true,
    loggedIn: null,
    resetLabel: null,
    resetRelative: null,
    autoPercent: null,
    apiPercent: null,
    onDemand: null,
    note: null,
    title,
    url,
    accountAvatarUrl: null,
  };
  if (typeof snapshot.accountAvatarUrl === "string" && snapshot.accountAvatarUrl.trim()) {
    out.accountAvatarUrl = snapshot.accountAvatarUrl.trim();
  }

  const lowerTitle = title.toLowerCase();
  if (lowerTitle.includes("just a moment") || lowerTitle.includes("attention required")) {
    out.loggedIn = null;
    out.note = "Waiting for Cursor / Cloudflare — try Refresh in a few seconds.";
    return out;
  }

  /**
   * Only dedicated auth URLs. The spending dashboard can mention "Sign in" in the nav; the
   * old loginHints early return ran before __NEXT_DATA__ and caused false "logged out".
   */
  const onAuthLoginPath =
    /cursor\.com\/(api\/)?auth\/login/i.test(url) || /authenticator\.cursor/i.test(url);

  if (onAuthLoginPath) {
    out.loggedIn = false;
    out.note = "Sign in via Cursor Stats → Sign in to Cursor…";
    return out;
  }

  const resetMatch =
    text.match(/Resets?\s+on\s+([^\n(]+?)\s*\(\s*([^)]+?)\s*\)/i) ||
    text.match(/Resets?\s+on\s+([^\n]+?)\s*$/im);

  if (resetMatch) {
    out.resetLabel = resetMatch[1].trim().replace(/\s+/g, " ");
    if (resetMatch[2]) out.resetRelative = resetMatch[2].trim();
  }

  const autoMatch =
    text.match(/(\d+)\s*%\s*(?:Auto|Auto\s*\+\s*Composer|Auto\+Composer)/i) ||
    text.match(/(?:Auto|Composer)\s*[:\s]+(\d+)\s*%/i);
  if (autoMatch) out.autoPercent = parseInt(autoMatch[1], 10);

  const apiMatch = text.match(/(\d+)\s*%\s*API/i) || text.match(/API\s*[:\s]+(\d+)\s*%/i);
  if (apiMatch) out.apiPercent = parseInt(apiMatch[1], 10);

  const od1 = text.match(
    /(?:on[-\s]?demand|overage|additional)[^\n$]{0,80}?\$\s*([\d,]+(?:\.\d+)?)\s*\/\s*\$\s*([\d,]+(?:\.\d+)?)/i,
  );
  const od2 = text.match(/\$\s*([\d,]+(?:\.\d+)?)\s*\/\s*\$\s*([\d,]+(?:\.\d+)?)\s+used/i);
  const od = od1 || od2;
  if (od) {
    const used = parseMoney(od[1]);
    const limit = parseMoney(od[2]);
    if (used != null && limit != null) out.onDemand = { used, limit };
  }

  if (snapshot.nextData && typeof snapshot.nextData === "object") {
    walkNextData(snapshot.nextData, out);
  }

  const hasUsage = out.autoPercent != null || out.apiPercent != null || out.resetLabel != null || out.onDemand != null;
  if (hasUsage) {
    out.loggedIn = true;
  } else if (text.length > 8000) {
    out.loggedIn = true;
    out.note = "Page loaded but usage fields were not recognized. Dashboard layout may have changed.";
  } else {
    out.loggedIn = false;
    out.note = out.note || "Could not read usage. Open Sign in and complete login, then Refresh.";
  }

  return out;
}

module.exports = { parseSpendingSnapshot };
