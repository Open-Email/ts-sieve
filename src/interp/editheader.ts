// RFC 5293 editheader.
//
// editheader is "virtual": addheader/deleteheader record an ordered ledger on
// RuntimeData.headerEdits, and every header read (header/exists/address tests +
// deleteheader's own value lookup) replays the ledger over the raw header values
// via applyHeaderEditsToValues. The message itself is never rewritten.

import { decodeHeaderValue } from "./header.js";
import { MatcherTest } from "./matcher.js";
import type { MatchOptions } from "./matching.js";
import { type Cmd, type Mark, type RuntimeData, type Tri, withShare } from "./runtime.js";
import { expandMarked, expandVarsList } from "./variables.js";

export interface HeaderEdit {
  action: "add" | "delete";
  fieldName: string;
  value: string;
  last: boolean; // add: append vs prepend; delete: count :index from the end
  index: number; // delete: 1-based specific occurrence (0 = all)
  /** add: the value was built from one the engine could not hold whole (see
   * Mark). Absent for a value held whole. */
  mark?: Mark;
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
 * values the host returned (`src`), and the marks of its values (null while
 * none is marked). */
const replays = new WeakMap<RuntimeData, Map<string, { n: number; src: string[]; out: string[]; marks: Mark[] | null }>>();

/** The marks of a replay's values, by position, when any is marked. */
const replayMarks = new WeakMap<string[], Mark[]>();

/**
 * The marks of the values getHeader returned, by position (see Mark), or
 * undefined when every one is held whole. An added value built from a marked
 * one is a prefix of what the script meant, or in doubt: a test over it
 * answers as TestString does over a marked source (see matchHeaderValue).
 */
export function valueMarks(values: string[]): readonly Mark[] | undefined {
  return replayMarks.get(values);
}

/**
 * Match a header value at `mark`: whole, after decoding; a prefix, as a cut
 * header is matched (a definite answer only where the prefix proves it); in
 * doubt, unknown. A prefix that holds an encoded word is in doubt too: the
 * whole may decode where the prefix does not, or drop the white space between
 * two encoded words the prefix ends between.
 */
export function matchHeaderValue(d: RuntimeData, matcher: MatcherTest, value: string, mark: Mark, opts: MatchOptions): Tri {
  if (mark === "doubt" || (mark === "prefix" && value.includes("=?"))) return "unknown";
  return matcher.tryMatch(d, decodeHeaderValue(value), opts, mark === "prefix");
}

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
  const marks = replayInto(out, same ? (last.marks?.slice() ?? null) : null, d.headerEdits, fn, same ? last.n : 0, n);
  if (marks !== null) replayMarks.set(out, marks);
  memo.set(fn, { n, src: values, out, marks });
  return out;
}

/** Apply edits[from, to) for field `fn` to `result`, in place, with `marks`
 * kept beside it: returned, or created when the first marked value is added.
 * Null while no value is marked. */
function replayInto(result: string[], marks: Mark[] | null, edits: HeaderEdit[], fn: string, from: number, to: number): Mark[] | null {
  for (let i = from; i < to; i++) {
    const edit = edits[i]!;
    if (edit.fieldName.toLowerCase() !== fn) continue;
    if (edit.action === "add") {
      const mark = edit.mark ?? "";
      if (marks === null && mark !== "") marks = result.map(() => "");
      if (edit.last) {
        result.push(edit.value);
        marks?.push(mark);
      } else {
        result.unshift(edit.value);
        marks?.unshift(mark);
      }
    } else if (edit.index > 0) {
      const idx = edit.last ? result.length - edit.index : edit.index - 1;
      if (idx >= 0 && idx < result.length) {
        result.splice(idx, 1);
        marks?.splice(idx, 1);
      }
    } else if (edit.value !== "") {
      // The value deleteheader matched, which is never a marked one (see
      // CmdDeleteHeader): a marked one of the same text is not it.
      let idx = result.indexOf(edit.value);
      while (marks !== null && idx !== -1 && marks[idx] !== "") idx = result.indexOf(edit.value, idx + 1);
      if (idx !== -1) {
        result.splice(idx, 1);
        marks?.splice(idx, 1);
      }
    } else {
      result.length = 0;
      if (marks !== null) marks.length = 0;
    }
  }
  return marks;
}

export class CmdAddHeader implements Cmd {
  fieldName = "";
  value = "";
  last = false;

  execute(d: RuntimeData): void {
    const { value: fieldName, mark: nameMark } = expandMarked(d, this.fieldName);
    // A name built from a value the engine could not hold whole is not the
    // script's: nothing is added under it, and the guess is disclosed (as
    // deleteheader's).
    if (nameMark !== "") {
      d.indeterminate = true;
      return;
    }
    if (!isValidHeaderName(fieldName)) return; // RFC 5293 §6: silently ignore
    // A full ledger takes nothing, so nothing is folded for it.
    if (!editFits(d, 0)) return;
    // The value keeps its mark: every later read of the field weighs it (see
    // valueMarks). Folding a prefix gives a prefix of the folded whole: a run
    // of line breaks the cut ended is removed, where whole it is removed or
    // becomes a space.
    const { value: raw, mark } = expandMarked(d, this.value);
    // In a loop the fold is charged by size: a literal has no expansion to pay.
    if (d.budget.shares > 0) d.budget.consume(raw.length >> 7);
    const value = foldHeaderValue(raw);
    if (!editFits(d, value.length)) return;
    d.headerEditBytes += value.length;
    d.headerEdits.push({ action: "add", fieldName, value, last: this.last, index: 0, ...(mark !== "" ? { mark } : {}) });
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
    const { value: fieldName, mark } = expandMarked(d, this.fieldName);
    // A name built from a value the engine could not hold whole is not the
    // whole input's: nothing is deleted on it, and the guess is disclosed.
    if (mark !== "") {
      d.indeterminate = true;
      return;
    }
    if (!isValidHeaderName(fieldName)) return;
    if (isProtectedHeader(fieldName)) return; // RFC 5293 §6

    const valuePatterns = expandVarsList(d, this.valuePatterns);
    if (valuePatterns.length === 0) {
      if (editFits(d, 0)) d.headerEdits.push({ action: "delete", fieldName, value: "", index: this.index, last: this.last });
      return;
    }

    const values = applyHeaderEditsToValues(d, fieldName, d.msg.headerGet(fieldName));
    if (values.length === 0) return;
    const marks = valueMarks(values);

    // The matching spends a share of the step budget, as a test does. When the
    // share runs out nothing is deleted, and the guess is disclosed as for an
    // unknown match (see valueMatchesPatterns).
    const edits: HeaderEdit[] = [];
    const savedVars = d.matchVariables;
    const r = withShare(d, this.shareIndex, () => {
      if (this.index > 0) {
        let idx = this.index - 1;
        if (this.last) idx = values.length - this.index;
        if (idx >= 0 && idx < values.length && this.valueMatchesPatterns(d, values[idx]!, marks?.[idx] ?? "")) {
          edits.push({ action: "delete", fieldName, value: values[idx]!, index: this.index, last: this.last });
        }
        return true;
      }
      for (let i = 0; i < values.length; i++) {
        const val = values[i]!;
        if (this.valueMatchesPatterns(d, val, marks?.[i] ?? "")) edits.push({ action: "delete", fieldName, value: val, index: 0, last: false });
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

  private valueMatchesPatterns(d: RuntimeData, value: string, mark: Mark): boolean {
    // An "unknown" (a glob over a value past the match-input cap, or over one
    // an addheader built from a marked value) reads as no-match here —
    // deleting a header on an unproven match would corrupt what every later
    // test reads — but the guess is disclosed like a branch's: later tests may
    // read a header this delete would have removed. Trimming a prefix keeps
    // it a prefix of the trimmed whole.
    const opts = { maxMatchInputLength: d.script.opts.maxMatchInputLength };
    let r: Tri = "unknown";
    if (mark === "" || (mark === "prefix" && !value.includes("=?"))) {
      r = this.matcher.tryMatch(d, decodeHeaderValue(value).trim(), opts, mark === "prefix");
    }
    if (r === "unknown") d.indeterminate = true;
    return r === true;
  }
}
