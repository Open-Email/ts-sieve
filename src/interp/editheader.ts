// RFC 5293 editheader.
//
// editheader is "virtual": addheader/deleteheader record an ordered ledger on
// RuntimeData.headerEdits, and every header read (header/exists/address tests +
// deleteheader's own value lookup) replays the ledger over the raw header values
// via applyHeaderEditsToValues. The message itself is never rewritten.

import { decodeHeaderValue } from "./header.js";
import { MatcherTest } from "./matcher.js";
import { type Cmd, type RuntimeData, withShare } from "./runtime.js";
import { expandVars, expandVarsList } from "./variables.js";

export interface HeaderEdit {
  action: "add" | "delete";
  fieldName: string;
  value: string;
  last: boolean; // add: append vs prepend; delete: count :index from the end
  index: number; // delete: 1-based specific occurrence (0 = all)
}

const PROTECTED_HEADERS = new Set(["received", "auto-submitted"]);

/** Header edits one execution may record, and the UTF-16 units of added values.
 * foreverypart repeats commands, so without them a loop over many parts grew
 * the ledger past a Worker's memory (56,730 edits, 221M characters). An edit
 * past either is dropped and the guess disclosed: later header reads miss it. */
const MAX_HEADER_EDITS = 1024;
const MAX_HEADER_EDIT_BYTES = 1024 * 1024;

/** Whether one more edit (adding `bytes`) fits; if not, disclose the drop. */
function editFits(d: RuntimeData, bytes: number): boolean {
  if (d.headerEdits.length < MAX_HEADER_EDITS && d.headerEditBytes + bytes <= MAX_HEADER_EDIT_BYTES) return true;
  d.indeterminate = true;
  return false;
}

/** RFC 2822 field-name: 1*ftext where ftext = %d33-57 / %d59-126 (excludes ctrl, SP, ':'). */
function isValidHeaderName(name: string): boolean {
  if (name.length === 0) return false;
  for (let i = 0; i < name.length; i++) {
    const c = name.charCodeAt(i);
    if (c < 33 || c > 126 || c === 58 /* ':' */) return false;
  }
  return true;
}

/**
 * Put an addheader value on one line. A raw CR, LF or NUL would let the value
 * inject header fields when a host serialises the edits, and refusing it with a
 * throw is worse: the value can come from the message (a captured encoded word
 * may decode to CRLF), and a thrown execute() skips every rule. RFC 5293 §4
 * lets an implementation fold instead, as Pigeonhole does. A run of line breaks
 * at either end of the value or before white space is a fold and is removed, as
 * unfolding removes it; any other becomes the space a fold would have inserted.
 * NUL is dropped (a literal one is refused at load, see loadAddHeader). One
 * pass, no regular expression: the value is message data.
 */
function foldHeaderValue(value: string): string {
  const n = value.length;
  let out = "";
  let from = 0;
  for (let i = 0; i < n; ) {
    if (!isBreakOrNul(value.charCodeAt(i))) {
      i++;
      continue;
    }
    out += value.slice(from, i);
    let breaks = false;
    for (; i < n && isBreakOrNul(value.charCodeAt(i)); i++) breaks ||= value.charCodeAt(i) !== 0;
    const next = value.charCodeAt(i); // NaN past the end
    if (breaks && out.length > 0 && i < n && next !== 0x20 && next !== 0x09) out += " ";
    from = i;
  }
  return from === 0 ? value : out + value.slice(from);
}

function isBreakOrNul(c: number): boolean {
  return c === 0x0d || c === 0x0a || c === 0;
}

function isProtectedHeader(name: string): boolean {
  return PROTECTED_HEADERS.has(name.toLowerCase());
}

/** Per execution and field: the replay of the first `n` edits over the
 * values the host returned (`src`). */
const replays = new WeakMap<RuntimeData, Map<string, { n: number; src: string[]; out: string[] }>>();

/**
 * Replay the header-edit ledger over a header's raw values. Field match is
 * case-insensitive; adds prepend (or append with :last); deletes remove by index
 * (1-based, :last counts from the end), by exact value (first occurrence), or all.
 *
 * Every header read replays, and foreverypart repeats both edits and reads:
 * replaying the whole ledger on each read, with a copy per add, cost tens of
 * seconds. The ledger only grows, so each field's last replay is kept and only
 * the edits since are applied to a copy of it (the arrays returned are never
 * changed afterwards). A host that returns a fresh array per headerGet call
 * just replays from the start.
 */
export function applyHeaderEditsToValues(d: RuntimeData, fieldName: string, values: string[]): string[] {
  const n = d.headerEdits.length;
  if (n === 0) return values;
  const fn = fieldName.toLowerCase();
  let memo = replays.get(d);
  if (memo === undefined) replays.set(d, (memo = new Map()));
  const last = memo.get(fn);
  const same = last !== undefined && (last.src === values || (last.src.length === 0 && values.length === 0));
  if (same && last.n === n) return last.out;
  const out = same ? last.out.slice() : [...values];
  replayInto(out, d.headerEdits, fn, same ? last.n : 0, n);
  memo.set(fn, { n, src: values, out });
  return out;
}

/** Apply edits[from, to) for field `fn` to `result`, in place. */
function replayInto(result: string[], edits: HeaderEdit[], fn: string, from: number, to: number): void {
  for (let i = from; i < to; i++) {
    const edit = edits[i]!;
    if (edit.fieldName.toLowerCase() !== fn) continue;
    if (edit.action === "add") {
      if (edit.last) result.push(edit.value);
      else result.unshift(edit.value);
    } else if (edit.index > 0) {
      const idx = edit.last ? result.length - edit.index : edit.index - 1;
      if (idx >= 0 && idx < result.length) result.splice(idx, 1);
    } else if (edit.value !== "") {
      const idx = result.indexOf(edit.value);
      if (idx !== -1) result.splice(idx, 1);
    } else {
      result.length = 0;
    }
  }
}

export class CmdAddHeader implements Cmd {
  fieldName = "";
  value = "";
  last = false;

  execute(d: RuntimeData): void {
    const fieldName = expandVars(d, this.fieldName);
    if (!isValidHeaderName(fieldName)) return; // RFC 5293 §6: silently ignore
    // A full ledger takes nothing, so nothing is folded for it.
    if (!editFits(d, 0)) return;
    const raw = expandVars(d, this.value);
    // In a loop the fold is charged by size: a literal has no expansion to pay.
    if (d.budget.shares > 0) d.budget.consume(raw.length >> 7);
    const value = foldHeaderValue(raw);
    if (!editFits(d, value.length)) return;
    d.headerEditBytes += value.length;
    d.headerEdits.push({ action: "add", fieldName, value, last: this.last, index: 0 });
  }
}

export class CmdDeleteHeader implements Cmd {
  readonly matcher = new MatcherTest();
  fieldName = "";
  valuePatterns: string[] = [];
  index = 0;
  last = false;
  /** This command's number among the script's budgeted work (see withShare). */
  shareIndex = 0;

  execute(d: RuntimeData): void {
    const fieldName = expandVars(d, this.fieldName);
    if (!isValidHeaderName(fieldName)) return;
    if (isProtectedHeader(fieldName)) return; // RFC 5293 §6

    const valuePatterns = expandVarsList(d, this.valuePatterns);
    if (valuePatterns.length === 0) {
      if (editFits(d, 0)) d.headerEdits.push({ action: "delete", fieldName, value: "", index: this.index, last: this.last });
      return;
    }

    const values = applyHeaderEditsToValues(d, fieldName, d.msg.headerGet(fieldName));
    if (values.length === 0) return;

    // The matching spends a share of the step budget, as a test does. When the
    // share runs out nothing is deleted, and the guess is disclosed as for an
    // unknown match (see valueMatchesPatterns).
    const edits: HeaderEdit[] = [];
    const savedVars = d.matchVariables;
    const r = withShare(d, this.shareIndex, () => {
      if (this.index > 0) {
        let idx = this.index - 1;
        if (this.last) idx = values.length - this.index;
        if (idx >= 0 && idx < values.length && this.valueMatchesPatterns(d, values[idx]!)) {
          edits.push({ action: "delete", fieldName, value: values[idx]!, index: this.index, last: this.last });
        }
        return true;
      }
      for (const val of values) {
        if (this.valueMatchesPatterns(d, val)) edits.push({ action: "delete", fieldName, value: val, index: 0, last: false });
      }
      return true;
    });
    if (r === "unknown") {
      d.matchVariables = savedVars; // a match before the share ran out proves nothing
      d.indeterminate = true;
      return;
    }
    for (const e of edits) if (editFits(d, 0)) d.headerEdits.push(e);
  }

  private valueMatchesPatterns(d: RuntimeData, value: string): boolean {
    const v = decodeHeaderValue(value).trim();
    // An "unknown" (a glob over a value past the match-input cap) reads as
    // no-match here — deleting a header on an unproven match would corrupt what
    // every later test reads — but the guess is disclosed like a branch's:
    // later tests may read a header this delete would have removed.
    const r = this.matcher.tryMatch(d, v, { maxMatchInputLength: d.script.opts.maxMatchInputLength });
    if (r === "unknown") d.indeterminate = true;
    return r === true;
  }
}
