// RFC 5703 §3 foreverypart and break.
//
// The loop runs its block once per MIME part: at the top level the message and
// every part nested in it, depth first; nested in another loop, the parts
// nested in that loop's current part. `break` ends the loop it names, or the
// closest one.
//
// Two things are particular to this interpreter. The loop is the only one in
// Sieve, so command dispatch is no longer bounded by the script's size: the
// iterations run under a share of the step budget (withShare), and a loop that
// runs out of it stops early, disclosed as `indeterminate` (an iteration it
// skipped might have acted). And over a body the host's read window cut, parts
// past the cut are never iterated: a loop that reaches the end of an open part
// list discloses the iterations it may have missed the same way. One that
// breaks before the end missed nothing.

import { currentPart, mimeTree, partText, subtree } from "./mime.js";
import { MAX_INPUT_LENGTH } from "./regex.js";
import { type Cmd, type RuntimeData, withShare } from "./runtime.js";
import { applySetModifiers, setVar } from "./variables.js";

/** Thrown by break; the loop it names (or the closest one) catches it. */
export class BreakSignal {
  constructor(readonly name: string) {}
}

export class CmdForEveryPart implements Cmd {
  name = "";
  block: Cmd[] = [];
  /** This loop's number among the script's budgeted work (see withShare). */
  shareIndex = 0;

  execute(d: RuntimeData): void {
    const cur = currentPart(d);
    const top = cur ?? mimeTree(d);
    const parts = cur === null ? subtree(top) : subtree(top).slice(1);
    let broke = false;
    const r = withShare(d, this.shareIndex, () => {
      d.budget.consume(parts.length); // the parts it walks, before the block costs
      for (const p of parts) {
        d.partStack.push(p);
        try {
          for (const c of this.block) {
            d.budget.consume(1);
            c.execute(d);
          }
        } catch (e) {
          if (e instanceof BreakSignal && (e.name === "" || e.name === this.name)) {
            broke = true;
            return true;
          }
          throw e;
        } finally {
          d.partStack.pop();
        }
      }
      return true;
    });
    if (r === "unknown" || (!broke && top.openBelow)) d.indeterminate = true;
  }
}

/**
 * RFC 5703 §7: store the current part's text in a variable. At most as many
 * octets are decoded as the engine matches (maxMatchInputLength, or its
 * default). A text the cut or that limit left incomplete is stored marked as
 * a prefix of the real one (see Mark), unless :first asked for no more
 * characters than were read; a later test that reads it answers what the
 * prefix proves. The same holds for a value the variable's own size limit
 * (maxVariableLen) cuts.
 * Each call is charged by the text's size: the modifiers and the variable
 * store are linear in it, and loops repeat the call.
 */
export class CmdExtractText implements Cmd {
  name = "";
  /** :first, in characters; -1 keeps everything. */
  first = -1;
  modifiers: string[] = [];

  execute(d: RuntimeData): void {
    const part = currentPart(d);
    let value = "";
    let exact = true;
    if (part !== null) {
      const { text, complete } = partText(d, part, d.script.opts.maxMatchInputLength || MAX_INPUT_LENGTH);
      d.budget.consume(text.length >> 10);
      value = text;
      exact = complete;
      if (this.first >= 0) {
        const head = firstChars(text, this.first);
        if (head !== null) {
          value = head;
          exact = true;
        }
      }
    }
    // Text a cut left incomplete is a prefix of the real text (see Mark), and
    // so is a value the variable's size limit cuts.
    const marked = applySetModifiers(d, this.modifiers, value, exact ? "" : "prefix");
    setVar(d, this.name, marked.value, marked.mark);
  }
}

/** The first n characters (code points, as RFC 5703 counts) of s, or null
 * when s has fewer. Walks only as far as it takes. */
function firstChars(s: string, n: number): string | null {
  let i = 0;
  for (let k = 0; k < n; k++) {
    if (i >= s.length) return null;
    const c = s.charCodeAt(i);
    i += c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00 ? 2 : 1;
  }
  return s.slice(0, i);
}

export class CmdBreak implements Cmd {
  name = "";

  execute(_d: RuntimeData): void {
    throw new BreakSignal(this.name);
  }
}
