/**
 * Derive billing cycle window from parsed dashboard stats (reset label + relative).
 * Heuristic: period ends on the stated reset day; period start is one calendar month earlier.
 * @see docs/ARCHITECTURE.md
 */

const MONTH_NAMES = {
  jan: 0,
  january: 0,
  feb: 1,
  february: 1,
  mar: 2,
  march: 2,
  apr: 3,
  april: 3,
  may: 4,
  jun: 5,
  june: 5,
  jul: 6,
  july: 6,
  aug: 7,
  august: 7,
  sep: 8,
  sept: 8,
  september: 8,
  oct: 9,
  october: 9,
  nov: 10,
  november: 10,
  dec: 11,
  december: 11,
};

/**
 * @returns {null | { day: number, month: number, year?: number }} month = 0..11
 */
function parseMonthDay(resetLabel) {
  if (!resetLabel || typeof resetLabel !== "string") return null;
  const s = resetLabel.trim();

  const iso = s.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (iso) {
    const year = parseInt(iso[1], 10);
    const month = parseInt(iso[2], 10) - 1;
    const day = parseInt(iso[3], 10);
    if (month >= 0 && month <= 11 && day >= 1 && day <= 31 && year >= 2020 && year <= 2100) {
      return { day, month, year };
    }
  }

  const dmY = s.match(/\b(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4})\b/i);
  if (dmY) {
    const day = parseInt(dmY[1], 10);
    const mon = MONTH_NAMES[dmY[2].toLowerCase()];
    const year = parseInt(dmY[3], 10);
    if (mon != null && day >= 1 && day <= 31 && year >= 2020 && year <= 2100) {
      return { day, month: mon, year };
    }
  }

  const mdY = s.match(/\b([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})\b/i);
  if (mdY) {
    const mon = MONTH_NAMES[mdY[1].toLowerCase()];
    const day = parseInt(mdY[2], 10);
    const year = parseInt(mdY[3], 10);
    if (mon != null && day >= 1 && day <= 31 && year >= 2020 && year <= 2100) {
      return { day, month: mon, year };
    }
  }

  const d1 = s.match(/^(\d{1,2})\s+([A-Za-z]{3,9})\b/i);
  if (d1) {
    const day = parseInt(d1[1], 10);
    const mon = MONTH_NAMES[d1[2].toLowerCase()];
    if (mon == null || day < 1 || day > 31) return null;
    return { day, month: mon };
  }
  const d2 = s.match(/^([A-Za-z]{3,9})\s+(\d{1,2})\b/i);
  if (d2) {
    const mon = MONTH_NAMES[d2[1].toLowerCase()];
    const day = parseInt(d2[2], 10);
    if (mon == null || day < 1 || day > 31) return null;
    return { day, month: mon };
  }
  return null;
}

function atLocalMidnight(year, monthIndex, day) {
  const d = new Date(year, monthIndex, day, 0, 0, 0, 0);
  return d;
}

function localYmd(date) {
  const y = date.getFullYear();
  const m = date.getMonth() + 1;
  const d = date.getDate();
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function addCalendarMonths(date, delta) {
  const d = new Date(date.getTime());
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + delta);
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, last));
  return d;
}

/**
 * @param {{ resetLabel: string | null, resetRelative: string | null }} stats
 * @returns {null | {
 *   periodStart: Date,
 *   periodEnd: Date,
 *   daysTotal: number,
 *   currentDayIndex: number,
 *   periodEndLabel: string
 * }}
 */
function computeBillingWindow(stats) {
  const md = parseMonthDay(stats?.resetLabel);
  if (!md) return null;

  const now = new Date();
  let periodEnd;

  if (md.year != null) {
    periodEnd = atLocalMidnight(md.year, md.month, md.day);
  } else {
    let year = now.getFullYear();
    periodEnd = atLocalMidnight(year, md.month, md.day);

    if (periodEnd.getTime() < now.getTime() - 60 * 86400000) {
      periodEnd = atLocalMidnight(year + 1, md.month, md.day);
    }
    if (periodEnd.getTime() > now.getTime() + 400 * 86400000) {
      periodEnd = atLocalMidnight(year - 1, md.month, md.day);
    }
  }

  const periodStart = addCalendarMonths(periodEnd, -1);
  periodStart.setHours(0, 0, 0, 0);
  periodEnd.setHours(0, 0, 0, 0);

  const msDay = 86400000;
  const daysTotal = Math.max(1, Math.round((periodEnd.getTime() - periodStart.getTime()) / msDay));

  let currentDayIndex = Math.floor((now.getTime() - periodStart.getTime()) / msDay);
  currentDayIndex = Math.max(0, Math.min(daysTotal, currentDayIndex));

  const periodEndLabel = String(stats.resetLabel).trim();

  return {
    periodStart,
    periodEnd,
    daysTotal,
    currentDayIndex,
    periodEndLabel,
    periodEndKey: localYmd(periodEnd),
    periodStartKey: localYmd(periodStart),
  };
}

module.exports = { computeBillingWindow, parseMonthDay };
