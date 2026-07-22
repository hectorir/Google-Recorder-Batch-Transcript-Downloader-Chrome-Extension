/** Shared date helpers (ES module). */

const MONTH_ABBR = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

const MONTHS = Object.fromEntries(MONTH_ABBR.map((m, i) => [m, i + 1]));

export function toISODate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function parseISODate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || "").trim());
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

/** Match Google Recorder "Created on" label, e.g. "2026 Jul 17". */
export function dateToRecorderLabel(d) {
  return `${d.getFullYear()} ${MONTH_ABBR[d.getMonth()]} ${d.getDate()}`;
}

/** Parse Recorder label "2026 Jul 17" (or similar) → local Date at midnight, or null. */
export function parseRecorderLabel(label) {
  if (!label) return null;
  const m = /(\d{4})\s+([A-Za-z]+)\s+(\d{1,2})/.exec(String(label).trim());
  if (!m) return null;
  const mon = MONTHS[m[2].slice(0, 3)];
  if (!mon) return null;
  const d = new Date(Number(m[1]), mon - 1, Number(m[3]));
  if (Number.isNaN(d.getTime())) return null;
  d.setHours(0, 0, 0, 0);
  return d;
}

export function daterangeLabels(startISO, endISO) {
  const start = parseISODate(startISO);
  const end = parseISODate(endISO);
  if (!start || !end) throw new Error("Invalid start or end date");
  if (end < start) throw new Error("End date is before start date");
  const labels = new Set();
  const cur = new Date(start);
  while (cur <= end) {
    labels.add(dateToRecorderLabel(cur));
    cur.setDate(cur.getDate() + 1);
  }
  return [...labels];
}

/** Inclusive calendar-day check using Recorder created labels. */
export function createdInRange(createdLabel, startISO, endISO) {
  const start = parseISODate(startISO);
  const end = parseISODate(endISO);
  if (!start || !end) return false;
  const d = parseRecorderLabel(createdLabel);
  if (!d) {
    // Fallback: exact label membership
    return daterangeLabels(startISO, endISO).includes(createdLabel);
  }
  const t = d.getTime();
  return t >= start.getTime() && t <= end.getTime();
}

export function sanitizeFilename(title, createdLabel) {
  let dateS = "unknown-date";
  const m = /(\d{4})\s+([A-Za-z]+)\s+(\d{1,2})/.exec(createdLabel || "");
  if (m) {
    const mon = MONTHS[m[2].slice(0, 3)] || 0;
    dateS = `${m[1]}-${String(mon).padStart(2, "0")}-${String(Number(m[3])).padStart(2, "0")}`;
  }
  let safe = String(title || "recording")
    .replace(/[^\w\s-]+/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 100);
  if (!safe) safe = "recording";
  return `${dateS}_${safe}.txt`;
}

export function presetRange(preset) {
  const end = new Date();
  end.setHours(0, 0, 0, 0);
  const start = new Date(end);
  switch (preset) {
    case "today":
      break;
    case "yesterday": {
      start.setDate(start.getDate() - 1);
      end.setDate(end.getDate() - 1);
      break;
    }
    case "last3":
      start.setDate(start.getDate() - 2);
      break;
    case "last7":
      start.setDate(start.getDate() - 6);
      break;
    case "last14":
      start.setDate(start.getDate() - 13);
      break;
    case "thisMonth":
      start.setDate(1);
      break;
    default:
      break;
  }
  return { start: toISODate(start), end: toISODate(end) };
}
