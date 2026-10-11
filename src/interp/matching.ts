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

/** ASCII-only lowercasing (i;ascii-casemap fold), one UTF-16 unit at a time
 * into a buffer: building the result a character at a time made folding a
 * large body slow, and lowering runs of A–Z by replace was slowest on
 * alternating case. Lone surrogates are copied as they are. */
export function toLowerASCII(s: string): string {
  if (!/[A-Z]/.test(s)) return s;
  const out = new Uint16Array(s.length);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out[i] = c >= 65 && c <= 90 ? c + 32 : c;
  }
  let r = "";
  for (let i = 0; i < out.length; i += 0x2000) r += String.fromCharCode(...out.subarray(i, i + 0x2000));
  return r;
}

/**
 * Context-free Unicode casemap fold (RFC 5051).
 *
 * String.prototype.toLowerCase() applies the Unicode Final_Sigma context rule:
 * Σ lowercases to ς at the end of a word, and to σ elsewhere. That causes
 * two problems:
 * 1. Over a cut input, the fold of a prefix is not a prefix of the fold of the
 *    whole ("ΑΣ" folds to "ας", but "ΑΣΑ" folds to "ασα"), breaking prefix
 *    decidability.
 * 2. RFC 5051 maps characters to titlecase, under which σ and ς both map to Σ.
 *    Mapping ς to σ produces a context-free canonical fold where σ and ς
 *    compare equal.
 */
export function toUnicodeCasemapFold(s: string): string {
  return s.toLowerCase().replace(/ς/g, "σ");
}

export interface MatchOptions {
  maxMatchInputLength?: number;
}

/** The fold a comparator compares under: i;octet compares as is, and
 * i;ascii-numeric compares numbers, never folded text. */
export function comparatorFold(comparator: Comparator): (s: string) => string {
  if (comparator === "i;ascii-casemap") return toLowerASCII;
  if (comparator === "i;unicode-casemap") return toUnicodeCasemapFold;
  return (s) => s;
}

/**
 * `:is`/`:contains` of a folded key against a folded value. `truncated`: the
 * value is a prefix of the real one, read as testStringPrefix reads it.
 */
export function compareFolded(match: Match, value: string, key: string, truncated: boolean): Tri {
  switch (match) {
    case "is":
      return truncated ? (key.startsWith(value) ? "unknown" : false) : value === key;
    case "contains":
      return value.includes(key) ? true : truncated ? "unknown" : false;
    default:
      throw new SieveError(`match type '${match}' must not reach compareFolded`);
  }
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
    case "i;unicode-casemap": {
      const v = toUnicodeCasemapFold(value);
      const k = toUnicodeCasemapFold(key);
      switch (match) {
        case "is":
          return v === k;
        case "contains":
          return v.includes(k);
        default:
          throw new SieveError(`match type '${match}' must not reach testString`);
      }
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
        ? toUnicodeCasemapFold
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
