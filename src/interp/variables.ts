// RFC 5229 variables (set/${...}/string).
//
// WORKER-SAFETY: a naive ${...} scan uses a regex with nested (?:…)* (ReDoS
// risk); this implementation avoids that by using a bounded LINEAR scanner (no
// regex over attacker-controlled header/variable text), so a hostile message
// can't trigger ReDoS or O(n²) scanning in a Worker.

import { SieveError } from "../errors.js";
import { MatcherTest } from "./matcher.js";
import type { Cmd, RuntimeData, Test, Tri } from "./runtime.js";
import type { Script } from "./script.js";

const VAR_NAME_MAX_SCAN = 300; // bound the } search — real names are ≤ 32 chars
const encoder = new TextEncoder();

const IDENT = /^([a-zA-Z_][a-zA-Z0-9_]*\.)*([a-zA-Z_][a-zA-Z0-9_]*|[0-9]+)$/;

/** RFC 5229 variable-ref grammar: (namespace.)?(identifier | digits). Linear. */
function isValidVarName(name: string): boolean {
  return name.length > 0 && name.length <= 128 && IDENT.test(name);
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

/** Substitute ${name}/${N}. Identity when `variables` is not required. */
export function expandVars(d: RuntimeData, s: string): string {
  if (!d.script.requiresExtension("variables") || !s.includes("${")) return s;
  let out = "";
  let i = 0;
  let close = -2;
  const n = s.length;
  while (i < n) {
    if (s.charCodeAt(i) === 36 /* $ */ && s.charCodeAt(i + 1) === 123 /* { */) {
      close = nextClose(s, i + 2, close);
      const name = varRefName(s, i, close);
      if (name !== null) {
        out += resolveVar(d, name);
        i = close + 1;
        continue;
      }
    }
    out += s[i];
    i++;
  }
  return out;
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

/** Store a user variable, truncating the value to MaxVariableLen (byte-aware). */
export function setVar(d: RuntimeData, name: string, value: string): void {
  const maxLen = d.script.opts.maxVariableLen;
  if (name.length > d.script.opts.maxVariableNameLen) {
    throw new SieveError(`variable name too long: ${name}`);
  }
  let v = value;
  if (encoder.encode(v).length > maxLen) {
    // Truncate to maxLen bytes, backing off a split UTF-8 sequence.
    const bytes = encoder.encode(v);
    let end = maxLen;
    while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--; // in a continuation byte
    v = new TextDecoder().decode(bytes.subarray(0, end));
  }
  const lower = name.toLowerCase();
  const dot = lower.indexOf(".");
  if (dot !== -1) throw new SieveError(`cannot set namespaced variable: ${name}`);
  d.variables.set(lower, v);
}

// ---------------------------------------------------------------------------
// set command + modifiers
// ---------------------------------------------------------------------------

type Modifier = { precedence: number; apply: (s: string) => string };

export const SET_MODIFIERS: Record<string, Modifier> = {
  lower: { precedence: 40, apply: (s) => s.toLowerCase() },
  upper: { precedence: 40, apply: (s) => s.toUpperCase() },
  lowerfirst: { precedence: 30, apply: (s) => (s ? s[0]!.toLowerCase() + s.slice(1) : s) },
  upperfirst: { precedence: 30, apply: (s) => (s ? s[0]!.toUpperCase() + s.slice(1) : s) },
  quotewildcard: { precedence: 20, apply: (s) => s.replace(/[\\*?]/g, (c) => `\\${c}`) },
  length: { precedence: 10, apply: (s) => String(Array.from(s).length) },
};

/**
 * RFC 5229: when `:quotewildcard` is the LAST-applied (lowest-precedence)
 * modifier, the value is truncated to the size limit here and a dangling escape
 * backslash is dropped, so the stored value stays a valid quoted pattern.
 * Byte-based + UTF-8-aware, mirroring setVar's truncation.
 */
function truncateQuoted(s: string, maxLen: number): string {
  const bytes = encoder.encode(s);
  if (bytes.length <= maxLen) return s;
  let until = maxLen;
  while (until > 0 && (bytes[until]! & 0xc0) === 0x80) until--; // in a UTF-8 continuation byte
  if (until > 0 && bytes[until - 1] === 0x5c /* \ */) until--; // drop a dangling escape backslash
  return new TextDecoder().decode(bytes.subarray(0, until));
}

export class CmdSet implements Cmd {
  name = "";
  value = "";
  modifiers: string[] = []; // in load order; applied high-precedence first

  execute(d: RuntimeData): void {
    setVar(d, this.name, applySetModifiers(d, this.modifiers, expandVars(d, this.value)));
  }
}

/** Apply set modifiers (RFC 5229 §4.1), highest precedence first; shared by
 * set and extracttext. */
export function applySetModifiers(d: RuntimeData, modifiers: string[], value: string): string {
  let v = value;
  const ordered = [...modifiers].sort((a, b) => (SET_MODIFIERS[b]?.precedence ?? 0) - (SET_MODIFIERS[a]?.precedence ?? 0));
  let lastPrec = 0;
  for (const m of ordered) {
    v = SET_MODIFIERS[m]!.apply(v);
    lastPrec = SET_MODIFIERS[m]!.precedence;
  }
  if (lastPrec === SET_MODIFIERS.quotewildcard!.precedence) {
    v = truncateQuoted(v, d.script.opts.maxVariableLen);
  }
  return v;
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
      for (const src of this.source) if (expandVars(d, src) !== "") n++;
      return this.matcher.countMatches(d, n);
    }
    let unknown = false;
    for (const src of this.source) {
      const r = this.matcher.tryMatch(d, expandVars(d, src), opts);
      if (r === true) return true;
      if (r === "unknown") unknown = true;
    }
    return unknown ? "unknown" : false;
  }
}
