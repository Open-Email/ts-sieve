// RFC 5229 variables (set/${...}/string).
//
// WORKER-SAFETY: a naive ${...} scan uses a regex with nested (?:…)* (ReDoS
// risk); this implementation avoids that by using a bounded LINEAR scanner (no
// regex over attacker-controlled header/variable text), so a hostile message
// can't trigger ReDoS or O(n²) scanning in a Worker.

import { SieveError } from "../errors.js";
import { MatcherTest } from "./matcher.js";
import { onGuess, type Cmd, type Mark, type RuntimeData, type Test, type Tri } from "./runtime.js";
import type { Script } from "./script.js";

const VAR_NAME_MAX_SCAN = 300; // bound the } search — real names are ≤ 32 chars
const encoder = new TextEncoder();

const IDENT = /^([a-zA-Z_][a-zA-Z0-9_]*\.)*([a-zA-Z_][a-zA-Z0-9_]*|[0-9]+)$/;

/** RFC 5229 variable-ref grammar: (namespace.)?(identifier | digits). Linear. */
function isValidVarName(name: string): boolean {
  return name.length > 0 && name.length <= 128 && IDENT.test(name);
}

/** A variable's mark (see Mark): a match variable's, or a user variable's. */
function markOf(d: RuntimeData, name: string): Mark {
  if (/^[0-9]+$/.test(name)) {
    const n = Number.parseInt(name, 10);
    return Number.isSafeInteger(n) && n >= 0 ? d.captureMark(n) : "";
  }
  const lower = name.toLowerCase();
  return lower.includes(".") ? "" : (d.varMarks.get(lower) ?? "");
}

function resolveVar(d: RuntimeData, name: string): string {
  if (/^[0-9]+$/.test(name)) {
    const n = Number.parseInt(name, 10);
    return Number.isSafeInteger(n) && n >= 0 ? d.matchVariable(n) : "";
  }
  const lower = name.toLowerCase();
  const dot = lower.indexOf(".");
  if (dot === -1) return d.variables.get(lower) ?? "";
  const ns = lower.slice(0, dot);
  const rest = lower.slice(dot + 1);
  if (ns === "envelope") {
    // The load check refuses this namespace without require "envelope", but a
    // late require "variables" (RFC 5228 §3.2's require-first is not enforced)
    // slips past it — so the runtime refuses to read it too.
    if (!d.script.requiresExtension("envelope")) return "";
    if (rest === "from") return d.envelope.envelopeFrom();
    if (rest === "to") return d.envelope.envelopeTo();
    if (rest === "auth") return d.envelope.authUsername();
    return "";
  }
  return ""; // unknown namespace
}

/**
 * The name of the variable reference whose "${" sits at `i`, given `close`, the
 * first "}" at or after i + 2 (-1: none) — or null when there is none: an
 * invalid name, or one longer than VAR_NAME_MAX_SCAN, is literal text.
 * Callers keep `close` across positions (nextClose), so a string full of "${"
 * is scanned once, not VAR_NAME_MAX_SCAN characters per "${".
 */
function varRefName(s: string, i: number, close: number): string | null {
  if (close === -1 || close - (i + 2) >= VAR_NAME_MAX_SCAN) return null;
  const name = s.slice(i + 2, close);
  return isValidVarName(name) ? name : null;
}

/** The first "}" at or after `from`, reusing `close` while it still qualifies
 * (it is the first one after an earlier, smaller `from`). -2: not searched. */
function nextClose(s: string, from: number, close: number): number {
  return close === -1 || close >= from ? close : s.indexOf("}", from);
}

/**
 * Substitute ${name}/${N}. Identity when `variables` is not required.
 *
 * Under a share of the budget (a test, or any command in a foreverypart loop;
 * see withShare) the expansion is charged for the template it scans, a step
 * per 64 characters (a reference costs 15-100 ns however little it yields),
 * and for what it produces, a step per 128 characters as it grows: whatever
 * reads it is linear in it, and a few references to a variable filled from
 * the message expand to megabytes, every iteration of a loop. A top-level
 * command is not charged: it runs once, and running out outside a share would
 * fail the script.
 */
export function expandVars(d: RuntimeData, s: string): string {
  const { value, mark } = expandMarked(d, s);
  // Read where its mark is not weighed: a test that did so cannot answer for
  // the whole input (see SharedTest). A command's use of it decides nothing.
  if (mark !== "") d.testDoubt = true;
  return value;
}

/**
 * expandVars, with the mark the expansion carries (see Mark): a prefix when
 * the last thing in it is a prefix-marked value, held whole before it; in
 * doubt when anything follows a marked value, or a value in doubt is in it.
 */
export function expandMarked(d: RuntimeData, s: string): { value: string; mark: Mark } {
  if (!d.script.requiresExtension("variables") || !s.includes("${")) return { value: s, mark: "" };
  const charge = d.budget.shares > 0;
  if (charge) d.budget.consume(1 + (s.length >> 6));
  let charged = 0;
  let out = "";
  // The mark of the last marked value, while nothing has followed it; doubt
  // once anything has.
  let last: Mark = "";
  let doubt = false;
  const append = (text: string, mark: Mark) => {
    if (text === "" && mark === "") return;
    if (last !== "") doubt = true;
    last = mark;
    out += text;
  };
  let i = 0;
  let close = -2;
  const n = s.length;
  while (i < n) {
    if (s.charCodeAt(i) === 36 /* $ */ && s.charCodeAt(i + 1) === 123 /* { */) {
      close = nextClose(s, i + 2, close);
      const name = varRefName(s, i, close);
      if (name !== null) {
        append(resolveVar(d, name), markOf(d, name));
        i = close + 1;
        if (charge && out.length >> 7 > charged) {
          d.budget.consume((out.length >> 7) - charged);
          charged = out.length >> 7;
        }
        continue;
      }
    }
    append(s[i]!, "");
    i++;
  }
  if (charge && out.length >> 7 > charged) d.budget.consume((out.length >> 7) - charged);
  return { value: out, mark: doubt ? "doubt" : last };
}

/**
 * RFC 5229 §3: "References to namespaces without a prior require statement for
 * the relevant extension MUST cause an error." Returns why a string's first
 * unreadable reference cannot be read — a namespace whose extension the script
 * did not require, or one no extension defines — or null when every reference
 * is readable. Match variables (${1}) and user variables always are; without
 * `variables` required, "${...}" is literal text and nothing is checked.
 */
export function unusableVarRef(script: Script, s: string): string | null {
  if (!script.requiresExtension("variables") || !s.includes("${")) return null;
  let close = -2;
  for (let i = s.indexOf("${"); i !== -1; i = s.indexOf("${", i + 1)) {
    close = nextClose(s, i + 2, close);
    if (close === -1) break; // no "}" left: no reference either
    const name = varRefName(s, i, close);
    if (name === null) continue;
    const dot = name.indexOf(".");
    if (dot === -1) continue;
    const ns = name.slice(0, dot).toLowerCase();
    if (ns === "envelope") {
      if (!script.requiresExtension("envelope")) return `variable \${${name}} needs require "envelope"`;
      continue;
    }
    return `variable \${${name}} is in the unknown namespace "${ns}"`;
  }
  return null;
}

export function expandVarsList(d: RuntimeData, list: string[]): string[] {
  if (!d.script.requiresExtension("variables")) return list;
  return list.map((v) => expandVars(d, v));
}

/**
 * The UTF-8 bytes of s when it is over maxLen bytes, or null when it fits. Only
 * its first maxLen units are encoded, which is all a cut to maxLen bytes
 * keeps: a UTF-16 unit is one to three bytes, so a string of at most maxLen / 3
 * units fits unread, and one of more than maxLen units does not.
 */
function overLimit(s: string, maxLen: number): Uint8Array | null {
  if (s.length * 3 <= maxLen) return null;
  const bytes = encoder.encode(s.length > maxLen ? s.slice(0, maxLen) : s);
  return s.length > maxLen || bytes.length > maxLen ? bytes : null;
}

/**
 * Store a user variable, truncating the value to maxVariableLen bytes (backing
 * off a split UTF-8 sequence), with the mark it carries (see Mark): a cut
 * value is a prefix of the real one, so a test that reads it answers for
 * what the prefix proves. `markCut` false: the value is the script's own
 * literal, cut the same way on every message, not a guess. Under a share it
 * is charged for what it stores, a step per 128 characters (a literal has no
 * expansion to pay for it).
 */
export function setVar(d: RuntimeData, name: string, value: string, mark: Mark = "", markCut = true): void {
  const maxLen = d.script.opts.maxVariableLen;
  if (name.length > d.script.opts.maxVariableNameLen) {
    throw new SieveError(`variable name too long: ${name}`);
  }
  if (d.budget.shares > 0) d.budget.consume(Math.min(value.length, maxLen) >> 7);
  let v = value;
  const bytes = overLimit(v, maxLen);
  if (bytes !== null) {
    let end = maxLen;
    while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--; // in a continuation byte
    v = new TextDecoder().decode(bytes.subarray(0, end));
    if (markCut && mark === "") mark = "prefix";
  }
  const lower = name.toLowerCase();
  const dot = lower.indexOf(".");
  if (dot !== -1) throw new SieveError(`cannot set namespaced variable: ${name}`);
  if (onGuess(d)) mark = "doubt";
  d.variables.set(lower, v);
  if (mark === "") d.varMarks.delete(lower);
  else d.varMarks.set(lower, mark);
}

// ---------------------------------------------------------------------------
// set command + modifiers
// ---------------------------------------------------------------------------

type Modifier = { precedence: number; apply: (s: string) => string };

/** s with its first character, a whole code point, mapped by f. */
function firstChar(s: string, f: (c: string) => string): string {
  if (s === "") return s;
  const w = s.codePointAt(0)! > 0xffff ? 2 : 1;
  return f(s.slice(0, w)) + s.slice(w);
}

/**
 * :lower over a prefix of the value. Lowering maps each character alone but
 * for a capital sigma, which lowers to final ς at the end of a word and to σ
 * elsewhere (Final_Sigma): one the cut left at the end is either. The result
 * is cut back to where the two readings agree, which is a prefix of the whole
 * value lowered.
 */
function lowerPrefix(s: string): string {
  const lowered = s.toLowerCase();
  const inWord = (s + "a").toLowerCase();
  for (let i = 0; i < lowered.length; i++) if (lowered.charCodeAt(i) !== inWord.charCodeAt(i)) return lowered.slice(0, i);
  return lowered;
}

export const SET_MODIFIERS: Record<string, Modifier> = {
  lower: { precedence: 40, apply: (s) => s.toLowerCase() },
  upper: { precedence: 40, apply: (s) => s.toUpperCase() },
  lowerfirst: { precedence: 30, apply: (s) => firstChar(s, (c) => c.toLowerCase()) },
  upperfirst: { precedence: 30, apply: (s) => firstChar(s, (c) => c.toUpperCase()) },
  quotewildcard: { precedence: 20, apply: (s) => s.replace(/[\\*?]/g, (c) => `\\${c}`) },
  length: { precedence: 10, apply: (s) => String(Array.from(s).length) },
};

/**
 * RFC 5229: when `:quotewildcard` is the LAST-applied (lowest-precedence)
 * modifier, the value is truncated to the size limit here and an escape the cut
 * separated from its character is dropped, so the stored value stays a valid
 * quoted pattern.
 * Byte-based + UTF-8-aware, mirroring setVar's truncation.
 */
function truncateQuoted(s: string, maxLen: number): string {
  const bytes = overLimit(s, maxLen);
  if (bytes === null) return s;
  let until = maxLen;
  while (until > 0 && (bytes[until]! & 0xc0) === 0x80) until--; // in a UTF-8 continuation byte
  // The trailing backslashes are escaped backslashes, pairs, then perhaps one
  // escape the cut separated from its character: an odd run ends in one.
  let run = 0;
  while (run < until && bytes[until - 1 - run] === 0x5c /* \ */) run++;
  if (run % 2 === 1) until--;
  return new TextDecoder().decode(bytes.subarray(0, until));
}

export class CmdSet implements Cmd {
  name = "";
  value = "";
  modifiers: string[] = []; // in load order; applied high-precedence first

  execute(d: RuntimeData): void {
    // A literal (no reference) is cut the same way on every message: that is
    // the script's own value, not a guess, so its cut is no mark.
    const literal = !this.value.includes("${");
    const expanded = expandMarked(d, this.value);
    const { value, mark } = applySetModifiers(d, this.modifiers, expanded.value, expanded.mark, !literal);
    setVar(d, this.name, value, mark, !literal);
  }
}

/**
 * Apply set modifiers (RFC 5229 §4.1), highest precedence first; shared by set
 * and extracttext, with the value's mark (see Mark): the case and escaping
 * modifiers keep a prefix a prefix, :length of a marked value is in doubt,
 * and :quotewildcard's truncation marks what it cuts (unless `markCut` is
 * false: a literal, as for setVar).
 *
 * Under a share of the budget (in a foreverypart loop) each modifier is
 * charged by the value it walks, a step per 128 characters, and
 * :quotewildcard by the escapes it added, a step per 16: an escape costs some
 * 15 ns, a hundred times a character of the case modifiers.
 */
export function applySetModifiers(d: RuntimeData, modifiers: string[], value: string, mark: Mark = "", markCut = true): { value: string; mark: Mark } {
  let v = value;
  const ordered = [...modifiers].sort((a, b) => (SET_MODIFIERS[b]?.precedence ?? 0) - (SET_MODIFIERS[a]?.precedence ?? 0));
  const charge = d.budget.shares > 0;
  let lastPrec = 0;
  for (const m of ordered) {
    if (charge) d.budget.consume(v.length >> 7);
    const before = v.length;
    v = m === "lower" && mark === "prefix" ? lowerPrefix(v) : SET_MODIFIERS[m]!.apply(v);
    if (m === "length" && mark !== "") mark = "doubt";
    if (charge && m === "quotewildcard") d.budget.consume((v.length - before) >> 4);
    lastPrec = SET_MODIFIERS[m]!.precedence;
  }
  if (lastPrec === SET_MODIFIERS.quotewildcard!.precedence) {
    const quoted = truncateQuoted(v, d.script.opts.maxVariableLen);
    if (quoted.length !== v.length && markCut && mark === "") mark = "prefix";
    v = quoted;
  }
  return { value: v, mark };
}

// ---------------------------------------------------------------------------
// string test
// ---------------------------------------------------------------------------

export class TestString implements Test {
  readonly matcher = new MatcherTest();
  source: string[] = [];

  check(d: RuntimeData): Tri {
    const opts = { maxMatchInputLength: d.script.opts.maxMatchInputLength };
    if (this.matcher.isCount()) {
      let n = 0;
      let doubt = false;
      d.budget.consume(this.source.length); // a step a source, as matching costs one a key
      for (const src of this.source) {
        const { value, mark } = expandMarked(d, src);
        // A non-empty prefix is a non-empty value; an empty one may not be.
        if (mark === "doubt" || (mark === "prefix" && value === "")) doubt = true;
        else if (value !== "") n++;
      }
      return doubt ? "unknown" : this.matcher.countMatches(d, n);
    }
    let unknown = false;
    for (const src of this.source) {
      // A source that is a prefix of the real value is matched as a cut
      // header is: a definite answer only where the prefix proves it.
      const { value, mark } = expandMarked(d, src);
      if (mark === "doubt") {
        unknown = true;
        continue;
      }
      const r = this.matcher.tryMatch(d, value, opts, mark === "prefix");
      if (r === true) return true;
      if (r === "unknown") unknown = true;
    }
    return unknown ? "unknown" : false;
  }
}
