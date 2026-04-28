/**
 * Persists per-billing-period usage snapshots under the app userData directory.
 * @see docs/ARCHITECTURE.md
 */

const path = require("path");
const fs = require("fs");

const FILE = "usage-history.json";

function historyFilePath(userData) {
  return path.join(userData, FILE);
}

function loadHistory(userData) {
  const p = historyFilePath(userData);
  try {
    const raw = fs.readFileSync(p, "utf8");
    const data = JSON.parse(raw);
    if (!data || !Array.isArray(data.entries)) return { entries: [] };
    return data;
  } catch {
    return { entries: [] };
  }
}

function saveHistory(userData, data) {
  const p = historyFilePath(userData);
  fs.writeFileSync(p, JSON.stringify({ version: 1, entries: data.entries }, null, 0), "utf8");
}

/**
 * Record one snapshot for the current billing period (latest wins per day index).
 */
function appendUsageSnapshot(userData, stats, billing) {
  if (!billing || !stats || stats.ok === false || stats.loggedIn !== true) return;
  if (stats.autoPercent == null && stats.apiPercent == null) return;

  const data = loadHistory(userData);
  const at = new Date().toISOString();
  const entry = {
    at,
    dayIndex: billing.currentDayIndex,
    autoPercent: stats.autoPercent ?? null,
    apiPercent: stats.apiPercent ?? null,
    periodEndKey: billing.periodEndKey,
  };

  const next = data.entries.filter((e) => e.periodEndKey !== billing.periodEndKey || e.dayIndex !== entry.dayIndex);
  next.push(entry);
  next.sort((a, b) => a.at.localeCompare(b.at));
  if (next.length > 800) next.splice(0, next.length - 800);
  saveHistory(userData, { entries: next });
}

function historyForPeriod(userData, periodEndKey) {
  const data = loadHistory(userData);
  return data.entries
    .filter((e) => e.periodEndKey === periodEndKey)
    .sort((a, b) => a.dayIndex - b.dayIndex || a.at.localeCompare(b.at));
}

module.exports = {
  loadHistory,
  appendUsageSnapshot,
  historyForPeriod,
};
