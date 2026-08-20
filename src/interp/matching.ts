// Comparators + match types.
//
// `:is`/`:contains` are direct string comparisons implemented here; `:matches`
// and `:regex` are handled in matcher.ts through the linear (Thompson-NFA)
// regex engine in regex.ts — never through JavaScript's backtracking RegExp —
// so hostile patterns cannot pin a Worker's CPU (no ReDoS class). `:value` and
// `:count` (RFC 5231 relational) live in relational.ts.

import { SieveError } from "../errors.js";
import { parseNumericPrefix } from "./relational.js";
import type { Tri } from "./runtime.js";

export type Comparator = "i;octet" | "i;ascii-casemap" | "i;ascii-numeric" | "i;unicode-casemap";
export const DefaultComparator: Comparator = "i;ascii-casemap";

export type Match = "is" | "contains" | "matches" | "value" | "count" | "regex";

export type AddressPart = "all" | "localpart" | "domain" | "user" | "detail";

/** ASCII-only lowercasing (i;ascii-casemap fold). */
export function toLowerASCII(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out += c >= 65 && c <= 90 ? String.fromCharCode(c + 32) : s[i];
  }
  return out;
}

export interface MatchOptions {
  maxMatchInputLength?: number;
}

/**
 * The boolean core of `:is`/`:contains` for all comparators. `matches`/`value`/
 * `count`/`regex` are routed elsewhere by MatcherTest and must not reach here.
 */
export function testString(
  comparator: Comparator,
  match: Match,
  value: string,
  key: string,
  _opts: MatchOptions,
): boolean {
  switch (comparator) {
    case "i;octet":
      switch (match) {
        case "is":
          return value === key;
        case "contains":
          return value.includes(key);
        default:
          throw new SieveError(`match type '${match}' must not reach testString`);
      }
    case "i;ascii-casemap":
      switch (match) {
        case "is":
          return toLowerASCII(value) === toLowerASCII(key);
        case "contains":
          return toLowerASCII(value).includes(toLowerASCII(key));
        default:
          throw new SieveError(`match type '${match}' must not reach testString`);
      }
    case "i;unicode-casemap":
      switch (match) {
        case "is":
          return value.toLowerCase() === key.toLowerCase();
        case "contains":
          return value.toLowerCase().includes(key.toLowerCase());
        default:
          throw new SieveError(`match type '${match}' must not reach testString`);
      }
    case "i;ascii-numeric":
      switch (match) {
        case "is": {
          // RFC 4790 §9.1.1: longest leading-digit prefix; non-numeric = +infinity,
          // and two infinities are equal.
          const l = parseNumericPrefix(value);
          const r = parseNumericPrefix(key);
          if (l === null && r === null) return true;
          if (l === null || r === null) return false;
          return l === r;
        }
        default:
          throw new SieveError("numeric comparator cannot be used with :contains or :matches");
      }
  }
}

/**
 * `:is`/`:contains` over a PREFIX of the real value (the host's body read
 * window cut it). The real value may extend `prefix` by any suffix — including
 * the empty one, so "truncated" only ever means MAY extend:
 *   contains: found in the prefix → definite true (a suffix cannot unfind it);
 *             not found → unknown (the key may sit past — or span — the cut).
 *   is:       the real value equals the key only if the key STARTS WITH the
 *             prefix (equality included); any other key is definite false.
 *             i;ascii-numeric is unknown outright — the leading digit run may
 *             extend past the cut.
 */
export function testStringPrefix(comparator: Comparator, match: Match, prefix: string, key: string): Tri {
  const fold =
    comparator === "i;octet"
      ? (x: string) => x
      : comparator === "i;unicode-casemap"
        ? (x: string) => x.toLowerCase()
        : toLowerASCII;
  switch (match) {
    case "contains":
      return testString(comparator, "contains", prefix, key, {}) ? true : "unknown";
    case "is":
      if (comparator === "i;ascii-numeric") return "unknown";
      return fold(key).startsWith(fold(prefix)) ? "unknown" : false;
    default:
      throw new SieveError(`match type '${match}' must not reach testStringPrefix`);
  }
}
