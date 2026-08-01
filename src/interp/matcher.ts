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
  toLowerASCII,
} from "./matching.js";
import { type CompiledRegex, compileRegex, patternToRegex } from "./regex.js";
import {
  RELATIONAL_OPS,
  compareNumericValue,
  compareString,
  parseNumericPrefix,
} from "./relational.js";
import type { RuntimeData } from "./runtime.js";
import type { Script } from "./script.js";
import type { Spec, SpecTag } from "./spec.js";
import { expandVars } from "./variables.js";

export class MatcherTest {
  comparator: Comparator = DefaultComparator;
  match: Match = "is";
  relational = "";
  key: string[] = [];
  private matchCnt = 0;
  private caseFold = false;
  /** Precompiled no-variable `:matches`/`:regex` patterns (null = compile per-execution). */
  private compiledKeys: (CompiledRegex | null)[] = [];

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
    } else if (this.match === "regex") {
      // Same for :regex, so malformed/oversized patterns fail at load (script
      // upload) instead of at message-delivery time.
      this.compiledKeys = this.key.map((k) => (k.includes("${") ? null : compileRegex(k)));
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

  tryMatch(d: RuntimeData, source: string, opts: MatchOptions): boolean {
    const reOpts = { maxInputLength: opts.maxMatchInputLength || undefined, budget: d.budget };
    for (let i = 0; i < this.key.length; i++) {
      d.budget.consume(1);
      const key = this.key[i]!;
      if (this.match === "matches") {
        const re = this.compiledKeys[i] ?? compileRegex(patternToRegex(expandVars(d, key), this.caseFold));
        const caps = re.findSubmatch(source, reOpts);
        if (caps !== null) {
          d.matchVariables = caps;
          return true;
        }
      } else if (this.match === "regex") {
        // :regex always uses the (unicode) engine; the value is pre-lowercased
        // per comparator, the pattern is untouched.
        let value = source;
        if (this.comparator === "i;ascii-casemap") value = toLowerASCII(source);
        else if (this.comparator === "i;unicode-casemap") value = source.toLowerCase();
        const re = this.compiledKeys[i] ?? compileRegex(expandVars(d, key));
        const caps = re.findSubmatch(value, reOpts);
        if (caps !== null) {
          d.matchVariables = caps;
          return true;
        }
      } else if (this.match === "value") {
        const k = expandVars(d, key);
        if (this.comparator === "i;ascii-numeric") {
          if (compareNumericValue(this.relational, parseNumericPrefix(source), parseNumericPrefix(k))) return true;
        } else {
          const fold = this.comparator === "i;octet" ? (x: string) => x : toLowerASCII;
          if (compareString(this.relational, fold(source), fold(k))) return true;
        }
      } else if (testString(this.comparator, this.match, source, expandVars(d, key), opts)) {
        return true;
      }
    }
    return false;
  }
}
