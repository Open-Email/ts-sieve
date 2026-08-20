// RFC 5293 editheader.
//
// editheader is "virtual": addheader/deleteheader record an ordered ledger on
// RuntimeData.headerEdits, and every header read (header/exists/address tests +
// deleteheader's own value lookup) replays the ledger over the raw header values
// via applyHeaderEditsToValues. The message itself is never rewritten.

import { SieveError } from "../errors.js";
import { decodeHeaderValue } from "./header.js";
import { MatcherTest } from "./matcher.js";
import type { Cmd, RuntimeData } from "./runtime.js";
import { expandVars, expandVarsList } from "./variables.js";

export interface HeaderEdit {
  action: "add" | "delete";
  fieldName: string;
  value: string;
  last: boolean; // add: append vs prepend; delete: count :index from the end
  index: number; // delete: 1-based specific occurrence (0 = all)
}

const PROTECTED_HEADERS = new Set(["received", "auto-submitted"]);

/** RFC 2822 field-name: 1*ftext where ftext = %d33-57 / %d59-126 (excludes ctrl, SP, ':'). */
function isValidHeaderName(name: string): boolean {
  if (name.length === 0) return false;
  for (let i = 0; i < name.length; i++) {
    const c = name.charCodeAt(i);
    if (c < 33 || c > 126 || c === 58 /* ':' */) return false;
  }
  return true;
}

function isProtectedHeader(name: string): boolean {
  return PROTECTED_HEADERS.has(name.toLowerCase());
}

/**
 * Replay the header-edit ledger over a header's raw values. Field match is
 * case-insensitive; adds prepend (or append with :last); deletes remove by index
 * (1-based, :last counts from the end), by exact value (first occurrence), or all.
 */
export function applyHeaderEditsToValues(d: RuntimeData, fieldName: string, values: string[]): string[] {
  if (d.headerEdits.length === 0) return values;
  let result = [...values];
  const fn = fieldName.toLowerCase();
  for (const edit of d.headerEdits) {
    if (edit.fieldName.toLowerCase() !== fn) continue;
    if (edit.action === "add") {
      result = edit.last ? [...result, edit.value] : [edit.value, ...result];
    } else {
      if (edit.index > 0) {
        let idx = edit.index - 1;
        if (edit.last) idx = result.length - edit.index;
        if (idx >= 0 && idx < result.length) {
          result = [...result.slice(0, idx), ...result.slice(idx + 1)];
        }
      } else if (edit.value !== "") {
        const out: string[] = [];
        let deleted = false;
        for (const v of result) {
          if (!deleted && v === edit.value) {
            deleted = true;
            continue;
          }
          out.push(v);
        }
        result = out;
      } else {
        result = [];
      }
    }
  }
  return result;
}

export class CmdAddHeader implements Cmd {
  fieldName = "";
  value = "";
  last = false;

  execute(d: RuntimeData): void {
    const fieldName = expandVars(d, this.fieldName);
    const value = expandVars(d, this.value);
    if (!isValidHeaderName(fieldName)) return; // RFC 5293 §6: silently ignore
    // A value with raw CR/LF/NUL (e.g. smuggled in via a variable) would let a
    // script inject extra header fields when the host serialises the edits.
    if (/[\r\n\0]/.test(value)) throw new SieveError("addheader: invalid header value");
    d.headerEdits.push({ action: "add", fieldName, value, last: this.last, index: 0 });
  }
}

export class CmdDeleteHeader implements Cmd {
  readonly matcher = new MatcherTest();
  fieldName = "";
  valuePatterns: string[] = [];
  index = 0;
  last = false;

  execute(d: RuntimeData): void {
    const fieldName = expandVars(d, this.fieldName);
    if (!isValidHeaderName(fieldName)) return;
    if (isProtectedHeader(fieldName)) return; // RFC 5293 §6

    const valuePatterns = expandVarsList(d, this.valuePatterns);
    if (valuePatterns.length === 0) {
      d.headerEdits.push({ action: "delete", fieldName, value: "", index: this.index, last: this.last });
      return;
    }

    const values = applyHeaderEditsToValues(d, fieldName, d.msg.headerGet(fieldName));
    if (values.length === 0) return;

    if (this.index > 0) {
      let idx = this.index - 1;
      if (this.last) idx = values.length - this.index;
      if (idx < 0 || idx >= values.length) return;
      if (!this.valueMatchesPatterns(d, values[idx]!)) return;
      d.headerEdits.push({ action: "delete", fieldName, value: values[idx]!, index: this.index, last: this.last });
      return;
    }

    for (const val of values) {
      if (this.valueMatchesPatterns(d, val)) {
        d.headerEdits.push({ action: "delete", fieldName, value: val, index: 0, last: false });
      }
    }
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
