// The shared match-type/comparator
// state for header/address/envelope/string/date/body/hasflag tests. `:is` and
// `:contains` route through testString; `:matches`/`:regex` compile to the
// linear regex engine (patterns without variable refs precompile at load);
// `:value`/`:count` route through the relational kernel.

import { SieveError } from "../errors.js";
import {
  DefaultComparator,
  type Comparator,
  type Match,
  type MatchOptions,
  testString,
  testStringPrefix,
  toLowerASCII,
} from "./matching.js";
import { byteLen, type CompiledRegex, compileRegex, patternToRegex } from "./regex.js";
import {
  RELATIONAL_OPS,
  compareNumericValue,
  compareString,
  parseNumericPrefix,
} from "./relational.js";
import type { RuntimeData, Tri } from "./runtime.js";
import type { Script } from "./script.js";
import type { Spec, SpecTag } from "./spec.js";
import { expandVars } from "./variables.js";

/**
 * Whether a `:matches` glob ends with an UNESCAPED `*`. Over a prefix of the
 * real value, a whole-input glob match is provable exactly when the trailing
 * star absorbs whatever the cut hid; any other matched shape (or a miss) is
 * "unknown". Walks the same escape rules patternToRegex applies.
 */
function globEndsWithStar(pattern: string): boolean {
  let escaped = false;
  let lastWasStar = false;
  for (const ch of pattern) {
    if (!escaped) {
      if (ch === "\\") {
        escaped = true;
        lastWasStar = false;
      } else {
        lastWasStar = ch === "*";
      }
    } else {
      escaped = false;
      lastWasStar = false;
    }
  }
  return !escaped && lastWasStar;
}

/**
 * Whether a `:regex` FOUND match over a prefix proves a match over the real
 * value. Search semantics make any hit inside the prefix a hit in the whole —
 * unless the pattern can anchor to the end, so any `$` (even escaped: the
 * over-approximation only ever demotes a definite answer to "unknown", never
 * the reverse) forfeits the proof.
 */
function regexSoundOnPrefix(pattern: string): boolean {
  return !pattern.includes("$");
}

export class MatcherTest {
  comparator: Comparator = DefaultComparator;
  match: Match = "is";
  relational = "";
  key: string[] = [];
  private matchCnt = 0;
  private caseFold = false;
  /** Precompiled no-variable `:matches`/`:regex` patterns (null = compile per-execution). */
  private compiledKeys: (CompiledRegex | null)[] = [];
  /** Per key: does a MATCH over a truncated input prove a match over the real
   * value? (`:matches`: trailing unescaped `*`; `:regex`: no `$`.) null =
   * variable-bearing key, decide per-run from the expanded pattern. */
  private soundKeys: (boolean | null)[] = [];

  /** Register the comparator/match-type/relational tags onto a test's spec. */
  addSpecTags(spec: Spec): Spec {
    const tags: Record<string, SpecTag> = spec.tags ?? {};
    tags["comparator"] = {
      needsValue: true,
      minStrCount: 1,
      maxStrCount: 1,
      noVariables: true,
      matchStr: (val) => {
        this.comparator = val[0] as Comparator;
      },
    };
    tags["is"] = {
      matchBool: () => {
        this.match = "is";
        this.matchCnt++;
      },
    };
    tags["contains"] = {
      matchBool: () => {
        this.match = "contains";
        this.matchCnt++;
      },
    };
    tags["matches"] = {
      matchBool: () => {
        this.match = "matches";
        this.matchCnt++;
      },
    };
    tags["regex"] = {
      matchBool: () => {
        this.match = "regex";
        this.matchCnt++;
      },
    };
    tags["value"] = {
      needsValue: true,
      minStrCount: 1,
      maxStrCount: 1,
      noVariables: true,
      matchStr: (val) => {
        this.match = "value";
        this.matchCnt++;
        this.relational = val[0]!;
      },
    };
    tags["count"] = {
      needsValue: true,
      minStrCount: 1,
      maxStrCount: 1,
      noVariables: true,
      matchStr: (val) => {
        this.match = "count";
        this.matchCnt++;
        this.relational = val[0]!;
      },
    };
    spec.tags = tags;
    return spec;
  }

  setKey(s: Script, key: string[]): void {
    this.key = key;

    if (this.matchCnt > 1) throw new SieveError("multiple match-types are not allowed");

    if (this.match === "count" || this.match === "value") {
      if (!s.requiresExtension("relational")) throw new SieveError("missing require 'relational'");
      if (!RELATIONAL_OPS.has(this.relational)) {
        throw new SieveError(`unknown relational operator: ${this.relational}`);
      }
    }

    if (this.match === "regex" && !s.requiresExtension("regex")) {
      throw new SieveError("missing require 'regex'");
    }

    // RFC 5228 §2.7.3: comparators other than i;octet and i;ascii-casemap must
    // be declared with require "comparator-<name>", which this interpreter
    // enforces.
    switch (this.comparator) {
      case "i;octet":
      case "i;ascii-casemap":
        break;
      case "i;unicode-casemap":
      case "i;ascii-numeric":
        if (!s.requiresExtension(`comparator-${this.comparator}`)) {
          throw new SieveError(`missing require 'comparator-${this.comparator}'`);
        }
        break;
      default:
        throw new SieveError(`unsupported comparator: ${this.comparator}`);
    }

    if ((this.match === "contains" || this.match === "matches") && this.comparator === "i;ascii-numeric") {
      throw new SieveError("numeric comparator cannot be used with :contains or :matches");
    }

    // :matches case-folding is applied via the compiled regex's (?i); default
    // comparator i;ascii-casemap folds, i;octet does not.
    this.caseFold = this.comparator === "i;ascii-casemap" || this.comparator === "i;unicode-casemap";
    if (this.match === "matches") {
      // Precompile patterns with no variable refs (throws at load on oversize);
      // ${...} keys compile per-run.
      this.compiledKeys = this.key.map((k) =>
        k.includes("${") ? null : compileRegex(patternToRegex(k, this.caseFold)),
      );
      this.soundKeys = this.key.map((k) => (k.includes("${") ? null : globEndsWithStar(k)));
    } else if (this.match === "regex") {
      // Same for :regex, so malformed/oversized patterns fail at load (script
      // upload) instead of at message-delivery time.
      this.compiledKeys = this.key.map((k) => (k.includes("${") ? null : compileRegex(k)));
      this.soundKeys = this.key.map((k) => (k.includes("${") ? null : regexSoundOnPrefix(k)));
    }
  }

  isCount(): boolean {
    return this.match === "count";
  }

  countMatches(d: RuntimeData, value: number): boolean {
    const v = BigInt(value);
    for (const k of this.key) {
      // RFC 5231/4790: the key is prepared as i;ascii-numeric — leading-digit
      // prefix, non-numeric = +infinity.
      const kNum = parseNumericPrefix(expandVars(d, k));
      if (compareNumericValue(this.relational, v, kNum)) return true;
    }
    return false;
  }

  /**
   * Three-valued: `sourceTruncated` marks `source` as a PREFIX of the real
   * value (the host's body read window cut it); `:matches`/`:regex` inputs can
   * additionally be cut by the engine's own maxMatchInputLength. A definite
   * answer must be provable from the prefix (see testStringPrefix and the
   * sound-on-prefix pattern rules above); anything else is "unknown", which the
   * caller accumulates instead of treating as a miss — the miss reading is how
   * a `not`-guarded test used to invert on bytes the engine never read. An
   * UNSOUND match never sets match variables: its captures reflect the cut, and
   * the verdict it supports is not returned.
   */
  tryMatch(d: RuntimeData, source: string, opts: MatchOptions, sourceTruncated = false): Tri {
    const reOpts = { maxInputLength: opts.maxMatchInputLength || undefined, budget: d.budget };
    const cap = opts.maxMatchInputLength || 0;
    let unknown = false;
    for (let i = 0; i < this.key.length; i++) {
      d.budget.consume(1);
      const key = this.key[i]!;
      if (this.match === "matches") {
        const re = this.compiledKeys[i] ?? compileRegex(patternToRegex(expandVars(d, key), this.caseFold));
        const truncated = sourceTruncated || (cap > 0 && byteLen(source) > cap);
        const caps = re.findSubmatch(source, reOpts);
        if (caps !== null) {
          if (!truncated || (this.soundKeys[i] ?? globEndsWithStar(expandVars(d, key)))) {
            d.matchVariables = caps;
            return true;
          }
          unknown = true; // matched the prefix, but whole-input semantics are undecidable
        } else if (truncated) {
          unknown = true;
        }
      } else if (this.match === "regex") {
        // :regex always uses the (unicode) engine; the value is pre-lowercased
        // per comparator, the pattern is untouched.
        let value = source;
        if (this.comparator === "i;ascii-casemap") value = toLowerASCII(source);
        else if (this.comparator === "i;unicode-casemap") value = source.toLowerCase();
        const re = this.compiledKeys[i] ?? compileRegex(expandVars(d, key));
        const truncated = sourceTruncated || (cap > 0 && byteLen(value) > cap);
        const caps = re.findSubmatch(value, reOpts);
        if (caps !== null) {
          // Search semantics: a hit inside the prefix is a hit in the whole,
          // unless the pattern can anchor to the end.
          if (!truncated || (this.soundKeys[i] ?? regexSoundOnPrefix(expandVars(d, key)))) {
            d.matchVariables = caps;
            return true;
          }
          unknown = true;
        } else if (truncated) {
          unknown = true;
        }
      } else if (this.match === "value") {
        if (sourceTruncated) {
          // A prefix cannot order against the key: the real value's fold may
          // sort on either side of it.
          unknown = true;
        } else {
          const k = expandVars(d, key);
          if (this.comparator === "i;ascii-numeric") {
            if (compareNumericValue(this.relational, parseNumericPrefix(source), parseNumericPrefix(k))) return true;
          } else {
            const fold = this.comparator === "i;octet" ? (x: string) => x : toLowerASCII;
            if (compareString(this.relational, fold(source), fold(k))) return true;
          }
        }
      } else if (sourceTruncated) {
        const r = testStringPrefix(this.comparator, this.match, source, expandVars(d, key));
        if (r === true) return true;
        if (r === "unknown") unknown = true;
      } else if (testString(this.comparator, this.match, source, expandVars(d, key), opts)) {
        return true;
      }
    }
    return unknown ? "unknown" : false;
  }
}
