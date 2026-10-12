// The shared match-type/comparator
// state for header/address/envelope/string/date/body/hasflag tests. `:is` and
// `:contains` fold the value once and compare (compareFolded, or testString for
// i;ascii-numeric); `:matches`/`:regex` compile to bounded NFAs
// (patterns without variable refs precompile at load);
// `:value`/`:count` route through the relational kernel.

import { compileUnicodeGlob } from "./unicode-glob.js";
import type { ValueProfile } from "./budget-reserve.js";
import { SieveError } from "../errors.js";
import {
  DefaultComparator,
  type Comparator,
  type Match,
  type MatchOptions,
  comparatorFold,
  compareFolded,
  testString,
  testStringPrefix,
} from "./matching.js";
import { byteLen, type CompiledRegex, compileRegex, MAX_COMPILE_WORK, MAX_INPUT_LENGTH, patternToRegex } from "./regex.js";
import {
  RELATIONAL_OPS,
  compareNumericValue,
  compareString,
  parseNumericPrefix,
} from "./relational.js";
import { doubtCaptures, markCutCaptures, markStaleCaptures, type RuntimeData, type Tri } from "./runtime.js";
import type { Script } from "./script.js";
import type { Spec, SpecTag } from "./spec.js";
import { expandMarked, expandVars } from "./variables.js";

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

/** How many UTF-16 units of values and their folds foldOnce keeps. */
const FOLD_CACHE_MAX = 4 * 1024 * 1024;

/**
 * A value's fold, kept for the execution: inside a foreverypart loop the same
 * header value is compared on every iteration, and folding a large one is real
 * work. Every call is charged by the value's size, a step per KiB, found or
 * not: looking a freshly built string up hashes all of it. The cache holds a
 * bounded amount; past it, values are folded each time. Values under 1 KiB
 * are not kept.
 */
function foldOnce(d: RuntimeData, kind: string, source: string, fold: (s: string) => string): string {
  if (source.length < 1024) return fold(source);
  d.budget.consume(source.length >> 10);
  let cache = d.foldCache.get(kind);
  if (cache === undefined) d.foldCache.set(kind, (cache = new Map()));
  let folded = cache.get(source);
  if (folded === undefined) {
    folded = fold(source);
    if (d.foldCacheUnits + source.length + folded.length <= FOLD_CACHE_MAX) {
      cache.set(source, folded);
      d.foldCacheUnits += source.length + folded.length;
    }
  }
  return folded;
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
  /** Per `:matches` key: does a MATCH over a truncated input prove a match
   * over the real value? (A trailing unescaped `*`.) null = variable-bearing
   * key, decide per-run from the expanded pattern. A `:regex` match decides it
   * at run time: see findSubmatch's info.atEnd. */
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

  private reserveStates: number | undefined;

  /** Conservative estimate for literal header matching. Dynamic patterns need
   * the fallback: estimating must not expand variables or compile message data. */
  reserveFor(values: ValueProfile, addresses = false): number | undefined {
    const keys = this.key.length;
    if (this.isCount()) return keys;
    const count = addresses ? values.count + Math.floor(values.units / 3) : values.count;
    if (this.match === "matches" || this.match === "regex") {
      const states = this.reserveStates;
      if (states === undefined) return undefined;
      // Addresses may split one field into many independently capped inputs.
      const units = addresses ? values.units + count : values.matchUnits;
      return keys * count + states * units;
    }
    const folds = this.comparator === "i;octet" || this.comparator === "i;ascii-numeric" ? 0 : values.foldSteps;
    return keys * count + folds + (this.match === "contains" ? keys * values.foldSteps : 0);
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

    // ASCII :matches uses the regex VM's (?i). Unicode globs prepare their
    // literals separately, preserving source characters for wildcards.
    this.caseFold = this.comparator === "i;ascii-casemap" || this.comparator === "i;unicode-casemap";
    if (this.match === "matches") {
      // Precompile patterns with no variable refs (throws at load on oversize);
      // ${...} keys compile per-run.
      this.compiledKeys = this.key.map((k) => (k.includes("${") ? null : this.compileKey(k)));
      this.soundKeys = this.key.map((k) => (k.includes("${") ? null : globEndsWithStar(k)));
    } else if (this.match === "regex") {
      // Same for :regex, so malformed/oversized patterns fail at load (script
      // upload) instead of at message-delivery time. Under a casemap
      // comparator the PATTERN compiles case-insensitively (the parser's
      // seeded `i` flag — the same fold `:matches` rides via patternToRegex's
      // `(?i)`), so the ORIGINAL value is matched and captured match variables
      // keep its case. Folding only the input, as this arm once did, made any
      // pattern containing an uppercase letter unmatchable ("^Ticket" could
      // never match "Ticket 4521 …": the input had been lowercased and the
      // pattern had not). The pattern text itself is never rewritten — a
      // textual `(?i)` prefix would shift parse positions and legalize
      // quantifier-first refusals, and lowercasing the text would corrupt
      // escapes (`\W` → `\w` inverts the class).
      this.compiledKeys = this.key.map((k) => (k.includes("${") ? null : this.compileKey(k)));
    }
    // This depends only on the uploaded script, not the message. Compute it
    // once at load so estimating many header fields never rescans key lists.
    this.reserveStates = this.compiledKeys.every((re) => re !== null)
      ? this.compiledKeys.reduce((sum, re) => sum + re!.programSize, 0)
      : undefined;
  }

  /** Compile a `:matches` glob or a `:regex` pattern; throws SieveError when it
   * does not compile or is past the pattern-length cap. */
  private compileKey(pattern: string): CompiledRegex {
    if (this.match === "matches") return this.comparator === "i;unicode-casemap"
      ? compileUnicodeGlob(pattern)
      : compileRegex(patternToRegex(pattern, this.caseFold));
    // Regex syntax stays untouched. The VM folds literal characters and the
    // parser closes character classes; source text and capture offsets stay exact.
    return compileRegex(pattern, { caseInsensitive: this.caseFold, unicodeCaseFold: this.comparator === "i;unicode-casemap" });
  }

  /**
   * Key `i` for this run, with its pattern text: the program compiled at load,
   * or, for a key holding a variable reference, the expanded text compiled now.
   * null when that does not compile. The text can come from the message, and a
   * throw here would end execute(), which a host's fail-open turns into "skip
   * every rule"; the caller reads null as "unknown" instead. The length cap
   * still applies to an expanded key: it bounds what the compiler builds and
   * the work each VM step does.
   */
  private runtimeKey(d: RuntimeData, i: number): { re: CompiledRegex | null; pattern: string } {
    const key = this.key[i]!;
    const re = this.compiledKeys[i];
    if (re) return { re, pattern: key };
    const { value: pattern, mark } = expandMarked(d, key);
    // A pattern built from a marked value is not the whole input's pattern:
    // no compile, and the comparison is unknown (see Mark).
    if (mark !== "") return { re: null, pattern };
    // A test matches every value of a field (or every body part) against the
    // same keys, and the expansion only changes when variables do: compile
    // once per expansion, per execution. The compile is charged, a step per
    // 100 calls, and a pattern that does not compile as the whole cap.
    let compiled = this.runtimeCompiled.get(d);
    if (compiled === undefined) this.runtimeCompiled.set(d, (compiled = []));
    const last = compiled[i];
    if (last !== undefined && last.pattern === pattern) return last;
    let out: CompiledRegex | null = null;
    try {
      out = this.compileKey(pattern);
    } catch (e) {
      if (!(e instanceof SieveError)) throw e;
    }
    d.budget.consume(1 + Math.floor((out?.compileWork ?? MAX_COMPILE_WORK) / 100));
    const entry = { re: out, pattern };
    compiled[i] = entry;
    return entry;
  }

  /** runtimeKey's last compile of each variable-bearing key, per execution. */
  private readonly runtimeCompiled = new WeakMap<RuntimeData, ({ re: CompiledRegex | null; pattern: string } | undefined)[]>();

  isCount(): boolean {
    return this.match === "count";
  }

  /** Compare a finite numeric lower bound. Exact truth from any key wins;
   * a remaining undecidable key contributes unknown to the disjunction. */
  matchAtLeast(d: RuntimeData, minimum: number): Tri {
    if (!this.isCount() && (this.match !== "value" || this.comparator !== "i;ascii-numeric")) return "unknown";
    let unknown = false;
    for (const key of this.key) {
      d.budget.consume(1);
      const { value, mark } = expandMarked(d, key);
      if (mark !== "") { unknown = true; continue; }
      const k = parseNumericPrefix(value);
      const min = BigInt(minimum);
      let r: Tri;
      if (k === null) r = compareNumericValue(this.relational, min, k);
      else if (this.relational === "gt") r = min > k ? true : "unknown";
      else if (this.relational === "ge") r = min >= k ? true : "unknown";
      else if (this.relational === "lt") r = min >= k ? false : "unknown";
      else if (this.relational === "le" || this.relational === "eq") r = min > k ? false : "unknown";
      else r = min > k ? true : "unknown"; // ne
      if (r === true) return true;
      if (r === "unknown") unknown = true;
    }
    return unknown ? "unknown" : false;
  }

  countMatches(d: RuntimeData, value: number): boolean {
    const v = BigInt(value);
    for (const k of this.key) {
      d.budget.consume(1); // a step a key, as matching costs one
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
   * answer must be provable from the prefix (see compareFolded and the
   * sound-on-prefix pattern rules above); anything else is "unknown", which the
   * caller accumulates instead of treating as a miss — the miss reading is how
   * a `not`-guarded test used to invert on bytes the engine never read. An
   * UNSOUND match never sets match variables: its captures reflect the cut, and
   * the verdict it supports is not returned.
   */
  tryMatch(d: RuntimeData, source: string, opts: MatchOptions, sourceTruncated = false): Tri {
    // The engine cuts every :matches/:regex input: at the host's cap, or at its
    // own default when the host sets none. Either cut leaves a prefix.
    const cap = opts.maxMatchInputLength || MAX_INPUT_LENGTH;
    const reOpts = { maxInputLength: cap, budget: d.budget };
    let foldedSource: string | undefined;
    let valueFolded: string | undefined;
    let unknown = false;
    for (let i = 0; i < this.key.length; i++) {
      d.budget.consume(1);
      const key = this.key[i]!;
      if (this.match === "matches") {
        const { re, pattern } = this.runtimeKey(d, i);
        if (re === null) {
          unknown = true;
          continue;
        }
        const truncated = sourceTruncated || byteLen(source) > cap;
        const caps = re.findSubmatch(source, reOpts);
        if (caps !== null) {
          if (!truncated || (this.soundKeys[i] ?? globEndsWithStar(pattern))) {
            if (d.captureDoubt || unknown) markStaleCaptures(caps);
            else if (truncated) markCutCaptures(caps, "matches");
            d.matchVariables = caps;
            return true;
          }
          unknown = true; // matched the prefix, but whole-input semantics are undecidable
        } else if (truncated) {
          unknown = true;
        }
      } else if (this.match === "regex") {
        // Match original text; Unicode case folding belongs to literal/class
        // instructions, so it cannot alter syntax, captures, or the byte cap.
        const value = source;
        const { re } = this.runtimeKey(d, i);
        if (re === null) {
          unknown = true;
          continue;
        }
        const truncated = sourceTruncated || byteLen(value) > cap;
        const info = { atEnd: false };
        const caps = re.findSubmatch(value, { ...reOpts, info });
        if (caps !== null) {
          // Search semantics: a hit inside the prefix is a hit in the whole,
          // unless an assertion decided it at the cut ($, \z, \b, \B look at
          // what follows, and nothing does there though the whole goes on).
          // Before the cut they see the same characters in both inputs.
          if (!truncated || !info.atEnd) {
            if (d.captureDoubt || unknown) markStaleCaptures(caps);
            else if (truncated) markCutCaptures(caps, "regex");
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
          const { value: k, mark } = expandMarked(d, key);
          if (mark !== "") {
            unknown = true; // a key built from a marked value (see Mark)
            continue;
          }
          if (this.comparator === "i;ascii-numeric") {
            if (compareNumericValue(this.relational, parseNumericPrefix(source), parseNumericPrefix(k))) return true;
          } else {
            // Folded once, as for :is/:contains below.
            const fold = comparatorFold(this.comparator);
            valueFolded ??= this.comparator === "i;octet" ? source : foldOnce(d, this.comparator === "i;unicode-casemap" ? "unicode" : "ascii", source, fold);
            if (compareString(this.relational, valueFolded, fold(k))) return true;
          }
        }
      } else {
        // :is/:contains. The value is folded once per comparison, not once per
        // key (1,000 keys over a 1 MiB body took seconds, charged a step each),
        // and charged by the value's size, a step per KiB: once for the fold,
        // and for :contains once per key searched through it.
        const { value: k, mark } = expandMarked(d, key);
        if (mark !== "") {
          unknown = true; // a key built from a marked value (see Mark)
          continue;
        }
        let r: Tri;
        if (this.match === "contains") d.budget.consume(source.length >> 10);
        if (this.comparator === "i;ascii-numeric") {
          r = sourceTruncated ? testStringPrefix(this.comparator, this.match, source, k) : testString(this.comparator, this.match, source, k, opts);
        } else {
          foldedSource ??=
            this.comparator === "i;octet"
              ? source
              : foldOnce(d, this.comparator === "i;unicode-casemap" ? "unicode" : "ascii", source, comparatorFold(this.comparator));
          r = compareFolded(this.match, foldedSource, comparatorFold(this.comparator)(k), sourceTruncated);
        }
        if (r === true) return true;
        if (r === "unknown") unknown = true;
      }
    }
    if (unknown) doubtCaptures(d);
    return unknown ? "unknown" : false;
  }
}
