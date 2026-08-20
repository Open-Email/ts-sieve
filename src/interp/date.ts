// RFC 5260 date/currentdate + the index
// extension's :index/:last on `date`.
//
// TIMEZONE SAFETY: a JS Date is instant-only — it has no attached zone.
// We model a ZonedTime = { epochMs, offsetSec } and read every wall-clock field
// via getUTC* of (epochMs + offsetSec*1000). applyZone only changes offsetSec.
// "local"/default ⇒ offset 0 (UTC, as on Workers) — deterministic, no Intl.

import { SieveError } from "../errors.js";
import { getHeader } from "./header.js";
import { MatcherTest } from "./matcher.js";
import type { RuntimeData, Test, Tri } from "./runtime.js";
import { expandVars } from "./variables.js";

export type DatePart =
  | "year" | "month" | "day" | "date" | "julian" | "hour" | "minute"
  | "second" | "time" | "iso8601" | "std11" | "zone" | "weekday";

export const VALID_DATE_PARTS = new Set<string>([
  "year", "month", "day", "date", "julian", "hour", "minute",
  "second", "time", "iso8601", "std11", "zone", "weekday",
]);

interface ZonedTime {
  epochMs: number;
  offsetSec: number;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_IDX: Record<string, number> = Object.fromEntries(MONTHS.map((m, i) => [m.toLowerCase(), i]));

const pad2 = (n: number) => String(n).padStart(2, "0");

function zoneNoColon(offsetSec: number): string {
  const sign = offsetSec < 0 ? "-" : "+";
  const a = Math.abs(offsetSec);
  return `${sign}${pad2(Math.trunc(a / 3600))}${pad2(Math.trunc((a % 3600) / 60))}`;
}
function zoneColon(offsetSec: number): string {
  const sign = offsetSec < 0 ? "-" : "+";
  const a = Math.abs(offsetSec);
  return `${sign}${pad2(Math.trunc(a / 3600))}:${pad2(Math.trunc((a % 3600) / 60))}`;
}

function modifiedJulianDay(dt: Date): number {
  const year = dt.getUTCFullYear();
  const month = dt.getUTCMonth() + 1;
  const day = dt.getUTCDate();
  const a = Math.trunc((14 - month) / 12);
  const y = year + 4800 - a;
  const m = month + 12 * a - 3;
  const jdn =
    day + Math.trunc((153 * m + 2) / 5) + 365 * y + Math.trunc(y / 4) - Math.trunc(y / 100) + Math.trunc(y / 400) - 32045;
  return jdn - 2400001;
}

function extractDatePart(zt: ZonedTime, part: DatePart): string {
  const dt = new Date(zt.epochMs + zt.offsetSec * 1000);
  const y = dt.getUTCFullYear();
  const mo = dt.getUTCMonth() + 1;
  const d = dt.getUTCDate();
  const h = dt.getUTCHours();
  const mi = dt.getUTCMinutes();
  const s = dt.getUTCSeconds();
  switch (part) {
    case "year":
      return String(y);
    case "month":
      return pad2(mo);
    case "day":
      return pad2(d);
    case "date":
      return `${y}-${pad2(mo)}-${pad2(d)}`;
    case "julian":
      return String(modifiedJulianDay(dt));
    case "hour":
      return pad2(h);
    case "minute":
      return pad2(mi);
    case "second":
      return pad2(s);
    case "time":
      return `${pad2(h)}:${pad2(mi)}:${pad2(s)}`;
    case "iso8601":
      return `${y}-${pad2(mo)}-${pad2(d)}T${pad2(h)}:${pad2(mi)}:${pad2(s)}${zoneColon(zt.offsetSec)}`;
    case "std11":
      return `${DOW[dt.getUTCDay()]}, ${pad2(d)} ${MONTHS[mo - 1]} ${y} ${pad2(h)}:${pad2(mi)}:${pad2(s)} ${zoneNoColon(zt.offsetSec)}`;
    case "zone":
      return zoneNoColon(zt.offsetSec);
    case "weekday":
      return String(dt.getUTCDay());
  }
}

function strictAtoi(s: string): number {
  if (!/^[+-]?\d+$/.test(s)) throw new SieveError(`invalid number: ${s}`);
  return Number.parseInt(s, 10);
}

export function parseZoneOffset(zone: string): number {
  if (zone.length !== 5) throw new SieveError("invalid zone format");
  let sign = 1;
  if (zone[0] === "-") sign = -1;
  else if (zone[0] !== "+") throw new SieveError("invalid zone format");
  const hours = strictAtoi(zone.slice(1, 3));
  const minutes = strictAtoi(zone.slice(3, 5));
  return sign * (hours * 3600 + minutes * 60);
}

/** Two-digit year rule: 00–68 ⇒ 2000–2068, 69–99 ⇒ 1969–1999. */
function expandYear(y: number, digits: number): number {
  if (digits >= 4) return y;
  return y <= 68 ? 2000 + y : 1900 + y;
}

/**
 * Parse an RFC 5322 date header into a ZonedTime, or null if unparseable.
 * Parses the common shapes of RFC 5322 date-time, plus fallback
 * layouts with a linear tokenizer (no backtracking regex over attacker input).
 */
function parseDateHeader(value: string): ZonedTime | null {
  if (value.includes("\r") && !value.includes("\r\n")) return null;
  let s = value.replace(/[\r\n]/g, "").trim();
  if (s === "") return null;
  // Strip a trailing CFWS comment: linear ([^()]* has no nesting).
  s = s.replace(/\s*\([^()]*\)\s*$/, "").trim();

  // ISO 8601 / RFC 3339: YYYY-MM-DD[T ]HH:MM:SS(Z|±HH:MM)
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/);
  if (iso) {
    const [, yy, mo, dd, hh, mm, ss, z] = iso;
    let offsetSec = 0;
    if (z && z !== "Z" && z !== "z") {
      const zc = z.replace(":", "");
      offsetSec = parseZoneOffset(zc.length === 5 ? zc : `${zc[0]}${zc.slice(1).padStart(4, "0")}`);
    }
    const epochMs = Date.UTC(+yy!, +mo! - 1, +dd!, +hh!, +mm!, ss ? +ss : 0) - offsetSec * 1000;
    return { epochMs, offsetSec };
  }

  // RFC 5322: [Ddd,] D Mon YYYY HH:MM[:SS] ZONE
  const toks = s.split(/\s+/);
  if (toks.length && /,$/.test(toks[0]!)) toks.shift(); // drop weekday prefix "Tue,"
  if (toks.length < 4) return null;
  const day = strictSafe(toks[0]!);
  if (day === null || day < 1 || day > 31) return null;
  const monIdx = MONTH_IDX[toks[1]!.slice(0, 3).toLowerCase()];
  if (monIdx === undefined) return null;
  const yRaw = toks[2]!;
  if (!/^\d{2,4}$/.test(yRaw)) return null;
  const year = expandYear(+yRaw, yRaw.length);
  const timeTok = toks[3];
  if (!timeTok) return null;
  const tm = timeTok.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!tm) return null;
  const hh = +tm[1]!;
  const mm = +tm[2]!;
  const ss = tm[3] ? +tm[3] : 0;

  let offsetSec = 0;
  const zoneTok = toks[4];
  if (zoneTok) {
    if (/^[+-]\d{4}$/.test(zoneTok)) offsetSec = parseZoneOffset(zoneTok);
    else offsetSec = 0; // named zone (MST/UT/GMT/…): fabricated offset 0 (UTC host)
  }
  const epochMs = Date.UTC(year, monIdx, day, hh, mm, ss) - offsetSec * 1000;
  return { epochMs, offsetSec };
}

function strictSafe(s: string): number | null {
  return /^\d{1,2}$/.test(s) ? Number.parseInt(s, 10) : null;
}

/**
 * Parse a date from a header field value (RFC 5260 §4). The whole value is tried
 * first (`Date:`, `Resent-Date:`, …); if it does not parse and the value contains
 * a semicolon, the trailing segment after the final `;` is tried — this is how a
 * `Received:` field carries its date-time (`… id 1.2.3.4; Wed, 12 Nov 2014 …`).
 */
function parseHeaderDate(value: string): ZonedTime | null {
  const whole = parseDateHeader(value);
  if (whole !== null) return whole;
  const semi = value.lastIndexOf(";");
  if (semi !== -1) return parseDateHeader(value.slice(semi + 1));
  return null;
}

function matchOpts(d: RuntimeData) {
  return { maxMatchInputLength: d.script.opts.maxMatchInputLength };
}

export class DateTest implements Test {
  readonly matcher = new MatcherTest();
  header = "";
  datePart: DatePart = "year";
  zone = "";
  originalZone = false;
  index = 0;
  last = false;

  private applyZone(zt: ZonedTime): ZonedTime {
    if (this.originalZone) return zt;
    if (this.zone !== "") {
      try {
        return { epochMs: zt.epochMs, offsetSec: parseZoneOffset(this.zone) };
      } catch {
        /* fall through */
      }
    }
    return { epochMs: zt.epochMs, offsetSec: 0 }; // local ⇒ UTC on Workers
  }

  check(d: RuntimeData): Tri {
    // RAW header values (no RFC 2047 decode), but seen through the RFC 5293
    // editheader ledger so date tests observe addheader/deleteheader edits.
    const values = getHeader(d, expandVars(d, this.header));

    if (this.matcher.isCount()) {
      let n = 0;
      for (const v of values) if (parseHeaderDate(v) !== null) n++;
      return this.matcher.countMatches(d, n);
    }

    if (values.length === 0) return false;
    let value: string;
    if (this.index > 0) {
      let idx = this.index - 1;
      if (this.last) idx = values.length - this.index;
      if (idx < 0 || idx >= values.length) return false;
      value = values[idx]!;
    } else {
      value = values[0]!;
    }

    const parsed = parseHeaderDate(value);
    if (parsed === null) return false; // unparseable ⇒ no match (not an error)
    const zt = this.applyZone(parsed);
    return this.matcher.tryMatch(d, extractDatePart(zt, this.datePart), matchOpts(d));
  }
}

export class CurrentDateTest implements Test {
  readonly matcher = new MatcherTest();
  datePart: DatePart = "year";
  zone = "";

  check(d: RuntimeData): Tri {
    let offsetSec = 0;
    if (this.zone !== "") {
      try {
        offsetSec = parseZoneOffset(this.zone);
      } catch {
        offsetSec = 0;
      }
    }
    const zt: ZonedTime = { epochMs: Date.now(), offsetSec };
    return this.matcher.tryMatch(d, extractDatePart(zt, this.datePart), matchOpts(d));
  }
}
