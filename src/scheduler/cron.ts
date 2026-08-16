/**
 * Five-field UTC cron support for the durable scheduler (issue #86).
 *
 * Deployments run in UTC containers. This module therefore uses UTC calendar
 * fields only and intentionally performs no daylight-saving-time handling.
 * When both day-of-month and day-of-week are restricted, normal cron OR
 * semantics apply. `?` may replace exactly one of those fields.
 */

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const GREGORIAN_CYCLE_DAYS = 146_097;

export interface CronField {
  values: ReadonlySet<number>;
  wildcard: boolean;
  unspecified: boolean;
}

export interface CronSchedule {
  minute: CronField;
  hour: CronField;
  dayOfMonth: CronField;
  month: CronField;
  dayOfWeek: CronField;
}

interface FieldSpec {
  name: string;
  min: number;
  max: number;
  allowQuestion: boolean;
}

const FIELD_SPECS: readonly FieldSpec[] = [
  { name: "minute", min: 0, max: 59, allowQuestion: false },
  { name: "hour", min: 0, max: 23, allowQuestion: false },
  { name: "day-of-month", min: 1, max: 31, allowQuestion: true },
  { name: "month", min: 1, max: 12, allowQuestion: false },
  { name: "day-of-week", min: 0, max: 6, allowQuestion: true },
];

function invalid(message: string): Error {
  return new Error(`invalid cron: ${message}`);
}

function integer(text: string, spec: FieldSpec): number {
  if (!/^\d+$/.test(text)) throw invalid(`${spec.name} has malformed value '${text}'`);
  const value = Number(text);
  if (value < spec.min || value > spec.max) {
    throw invalid(`${spec.name} must be ${spec.min}..${spec.max}, got ${value}`);
  }
  return value;
}

function fullRange(spec: FieldSpec, step = 1): Set<number> {
  const values = new Set<number>();
  for (let value = spec.min; value <= spec.max; value += step) values.add(value);
  return values;
}

function parseField(text: string, spec: FieldSpec): CronField {
  if (text === "?") {
    if (!spec.allowQuestion) throw invalid(`? is not allowed in ${spec.name}`);
    return { values: new Set<number>(), wildcard: false, unspecified: true };
  }
  if (text === "*") return { values: fullRange(spec), wildcard: true, unspecified: false };
  if (text.startsWith("*/")) {
    const stepText = text.slice(2);
    if (!/^\d+$/.test(stepText)) throw invalid(`${spec.name} has malformed step '${text}'`);
    const step = Number(stepText);
    if (step < 1) throw invalid(`${spec.name} step must be at least 1`);
    return { values: fullRange(spec, step), wildcard: false, unspecified: false };
  }
  if (text.includes(",")) {
    const parts = text.split(",");
    if (parts.some((part) => part === "")) throw invalid(`${spec.name} has an empty list value`);
    return {
      values: new Set(parts.map((part) => integer(part, spec))),
      wildcard: false,
      unspecified: false,
    };
  }
  if (text.includes("-")) {
    const match = /^(\d+)-(\d+)$/.exec(text);
    if (!match) throw invalid(`${spec.name} has malformed range '${text}'`);
    const start = integer(match[1]!, spec);
    const end = integer(match[2]!, spec);
    if (start > end) throw invalid(`${spec.name} range starts after it ends`);
    const values = new Set<number>();
    for (let value = start; value <= end; value += 1) values.add(value);
    return { values, wildcard: false, unspecified: false };
  }
  return {
    values: new Set([integer(text, spec)]),
    wildcard: false,
    unspecified: false,
  };
}

/** Parses a strict five-field `minute hour dom month dow` UTC schedule. */
export function parseCron(cron: string): CronSchedule {
  const fields = cron.trim().split(/\s+/);
  if (cron.trim() === "" || fields.length !== FIELD_SPECS.length) {
    throw invalid(`expected 5 fields, got ${cron.trim() === "" ? 0 : fields.length}`);
  }
  const parsed = fields.map((field, index) => parseField(field!, FIELD_SPECS[index]!));
  const dayOfMonth = parsed[2]!;
  const dayOfWeek = parsed[4]!;
  if (dayOfMonth.unspecified && dayOfWeek.unspecified) {
    throw invalid("day-of-month and day-of-week cannot both be ?");
  }
  return {
    minute: parsed[0]!,
    hour: parsed[1]!,
    dayOfMonth,
    month: parsed[3]!,
    dayOfWeek,
  };
}

function dateMatches(schedule: CronSchedule, date: Date): boolean {
  if (!schedule.month.values.has(date.getUTCMonth() + 1)) return false;
  const dom = schedule.dayOfMonth;
  const dow = schedule.dayOfWeek;
  const domMatches = dom.values.has(date.getUTCDate());
  const dowMatches = dow.values.has(date.getUTCDay());
  if (dom.unspecified) return dowMatches;
  if (dow.unspecified) return domMatches;
  if (dom.wildcard && dow.wildcard) return true;
  if (dom.wildcard) return dowMatches;
  if (dow.wildcard) return domMatches;
  return domMatches || dowMatches;
}

/** Returns the next occurrence strictly after `afterMs`, as UTC epoch milliseconds. */
export function nextCronFire(cron: string, afterMs: number): number {
  if (!Number.isFinite(afterMs) || !Number.isSafeInteger(afterMs)) {
    throw new Error("afterMs must be a finite safe integer epoch timestamp");
  }
  const schedule = parseCron(cron);
  const firstMinute = Math.floor(afterMs / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
  const firstDate = new Date(firstMinute);
  if (Number.isNaN(firstDate.getTime())) throw new Error("afterMs is outside the supported Date range");
  const dayStart = Date.UTC(firstDate.getUTCFullYear(), firstDate.getUTCMonth(), firstDate.getUTCDate());
  const hours = [...schedule.hour.values].sort((a, b) => a - b);
  const minutes = [...schedule.minute.values].sort((a, b) => a - b);

  // Every valid Gregorian date pattern repeats within 400 years. Searching
  // one complete cycle lets impossible combinations such as 31 February
  // fail closed instead of looping forever.
  for (let offset = 0; offset <= GREGORIAN_CYCLE_DAYS; offset += 1) {
    const date = new Date(dayStart + offset * DAY_MS);
    if (Number.isNaN(date.getTime())) break;
    if (!dateMatches(schedule, date)) continue;
    for (const hour of hours) {
      for (const minute of minutes) {
        const candidate = date.getTime() + hour * 60 * MINUTE_MS + minute * MINUTE_MS;
        if (candidate >= firstMinute) return candidate;
      }
    }
  }
  throw invalid("schedule has no occurrence in a complete Gregorian cycle");
}
