// Which blocks could change what runs after them (see runtime.ts's onGuess).
//
// When an "unknown" decides an if/elsif/else arm, or a foreverypart loop may
// have missed iterations, the arm the whole input would run may differ. The
// actions in the arm that ran are on a guess either way. Whether what runs
// AFTER the arm is on a guess depends on what the other arm could have done:
// stop the run, write a variable, a flag or a header a later test reads, or
// change which later action is dropped at a limit. An arm that only files or
// keeps can do none of that, and a body rule that files a cut message must
// not put an unrelated forward after it on a guess.
//
// Computed once at load, conservatively: a command not listed as inert is
// taken to affect what follows.

import { CmdDiscard, CmdFileInto, CmdKeep, CmdRedirect } from "./action.js";
import { CmdElse, CmdElsif, CmdIf } from "./control.js";
import { CmdForEveryPart } from "./foreverypart.js";
import type { Cmd } from "./runtime.js";
import type { Script } from "./script.js";
import { CmdVacation } from "./vacation.js";

type Counts = { redirects: number; vacations: number };

/** Redirect and vacation commands in `cmds`, one in a loop counting as many. */
function count(cmds: Cmd[], inLoop: boolean, n: Counts): void {
  for (const c of cmds) {
    if (c instanceof CmdRedirect) n.redirects += inLoop ? Number.POSITIVE_INFINITY : 1;
    else if (c instanceof CmdVacation) n.vacations += inLoop ? 2 : 1;
    const block = blockOf(c);
    if (block !== null) count(block, inLoop || c instanceof CmdForEveryPart, n);
  }
}

function blockOf(c: Cmd): Cmd[] | null {
  const b = (c as { block?: unknown }).block;
  return Array.isArray(b) ? (b as Cmd[]) : null;
}

/** Set mayAffectLater on every arm and loop of the script, and the script's
 * redirectsMayCap. */
export function analyzeGuessScope(s: Script): void {
  const n: Counts = { redirects: 0, vacations: 0 };
  count(s.cmds, false, n);
  // A redirect can change which later one the limit drops only if the script
  // can reach the limit; a vacation, which response is recorded, only if
  // there are two.
  s.redirectsMayCap = n.redirects > s.opts.maxRedirects;
  const vacationsRepeat = n.vacations > 1;
  // A test may set the captures later references read (${1}), and discard
  // clears the flags hasflag reads.
  const capturesRead = s.requiresExtension("variables");
  const flagsRead = s.requiresExtension("imap4flags");

  /** Whether `cmds` could change what runs after them; sets mayAffectLater
   * on every arm and loop inside, each block walked once. */
  const mark = (cmds: Cmd[]): boolean => {
    let any = false;
    for (const c of cmds) {
      let affects: boolean;
      if (c instanceof CmdIf || c instanceof CmdElsif || c instanceof CmdElse || c instanceof CmdForEveryPart) {
        const inner = mark(c.block);
        c.mayAffectLater = inner;
        affects = inner || ((c instanceof CmdIf || c instanceof CmdElsif) && capturesRead);
      } else if (c instanceof CmdKeep || c instanceof CmdFileInto) {
        affects = false;
      } else if (c instanceof CmdRedirect) {
        affects = s.redirectsMayCap;
      } else if (c instanceof CmdVacation) {
        affects = vacationsRepeat;
      } else if (c instanceof CmdDiscard) {
        affects = flagsRead;
      } else {
        // stop, set, extracttext, the flag commands, editheader, break,
        // reject and anything else.
        const block = blockOf(c);
        if (block !== null) mark(block);
        affects = true;
      }
      any ||= affects;
    }
    return any;
  };
  mark(s.cmds);
}
