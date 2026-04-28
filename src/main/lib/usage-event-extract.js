/**
 * Extract event rows from Cursor usage-events API JSON. Shared so main and renderer
 * strategies use the same shape logic.
 * @see docs/ARCHITECTURE.md
 * @param {unknown} json
 * @returns {unknown[]}
 */
function extractEventsArray(json) {
  if (json == null) return [];
  if (Array.isArray(json)) return json;
  if (typeof json !== "object") return [];
  const j = /** @type {Record<string, unknown>} */ (json);
  if (Array.isArray(j.data)) return j.data;
  const cands = [
    j.usageEventsDisplay,
    j.usageEvents,
    j.usageEventList,
    j.usageEventRows,
    j.events,
    j.eventList,
    j.items,
    j.results,
    j.hits,
    j.rows,
    j.records,
    j.list,
  ];
  for (const c of cands) {
    if (Array.isArray(c)) return c;
  }
  if (j.data && typeof j.data === "object" && !Array.isArray(j.data)) {
    const d = /** @type {Record<string, unknown>} */ (j.data);
    for (const k of [d.usageEventsDisplay, d.usageEvents, d.events, d.items, d.results, d.rows]) {
      if (Array.isArray(k)) return k;
    }
  }
  const ignoreKeys = new Set(["teamId", "startDate", "endDate", "page", "pageSize"]);
  for (const [key, v] of Object.entries(j)) {
    if (ignoreKeys.has(key)) continue;
    if (Array.isArray(v) && v.length > 0) {
      const first = v[0];
      if (first != null && typeof first === "object" && !Array.isArray(first)) return v;
    }
  }
  return [];
}

module.exports = { extractEventsArray };
