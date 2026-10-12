// Analyze the effects of an arm or loop once, at load. Unobserved writes
// mark only their variables, captures, flags and header fields. Possible local
// stores and reject conflicts have separate disclosures. Control flow and
// action-limit interactions retain a conservative barrier for later actions.
// Unknown extension commands are treated as affecting control flow.

import { CmdAddFlag, CmdDiscard, CmdFileInto, CmdKeep, CmdRedirect, CmdRemoveFlag, CmdSetFlag } from "./action.js";
import { CmdElse, CmdElsif, CmdIf } from "./control.js";
import { CmdForEveryPart, CmdExtractText } from "./foreverypart.js";
import { CmdAddHeader, CmdDeleteHeader } from "./editheader.js";
import { CmdSet } from "./variables.js";
import { setsCaptures } from "./test.js";
import { emptyWrites, mergeWrites, type UncertainWrites } from "./uncertainty.js";
import { CmdReject } from "./reject.js";
import type { Cmd } from "./runtime.js";
import type { Script } from "./script.js";
import { CmdVacation } from "./vacation.js";

type Counts = { redirects: number; vacations: number; rejects: number; fileintos: number };

/** Redirect and vacation commands in `cmds`, one in a loop counting as many. */
function count(cmds: Cmd[], inLoop: boolean, n: Counts): void {
  for (const c of cmds) {
    if (c instanceof CmdRedirect) n.redirects += inLoop ? Number.POSITIVE_INFINITY : 1;
    else if (c instanceof CmdVacation) n.vacations += inLoop ? 2 : 1;
    else if (c instanceof CmdReject) n.rejects += 1;
    else if (c instanceof CmdFileInto) n.fileintos += inLoop ? Number.POSITIVE_INFINITY : 1;
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
  const n: Counts = { redirects: 0, vacations: 0, rejects: 0, fileintos: 0 };
  count(s.cmds, false, n);
  s.hasReject = n.rejects > 0;
  s.hasVacation = n.vacations > 0;
  // A redirect can change which later one the limit drops only if the script
  // can reach the limit; a vacation, which response is recorded, only if
  // there are two.
  s.redirectsMayCap = n.redirects > s.opts.maxRedirects;
  s.fileintosMayCap = n.fileintos > s.opts.maxFileintos;
  const vacationsRepeat = n.vacations > 1;
  // A test may set the captures later references read (${1}). The internal
  // flag set is read only by hasflag: a script without one (the JSON rules
  // tag mail, and never test a flag) cannot be steered by a flag written.
  const capturesRead = s.requiresExtension("variables");
  const flagsRead = s.readsFlags;

  type Effects = { affects: boolean; vacation: boolean; reject: boolean; local: boolean; conflict: boolean; writes: UncertainWrites };

  const mark = (cmds: Cmd[]): Effects => {
    const e: Effects = { affects: false, vacation: false, reject: false, local: false, conflict: false, writes: emptyWrites() };
    for (const c of cmds) {
      let affects = false;
      if (c instanceof CmdIf || c instanceof CmdElsif || c instanceof CmdElse || c instanceof CmdForEveryPart) {
        const inner = mark(c.block);
        c.mayAffectLater = inner.affects;
        c.mayVacation = inner.vacation;
        c.mayReject = inner.reject;
        c.mayKeepLocal = inner.local;
        c.mayConflictReject = inner.conflict;
        c.uncertainWrites = inner.writes;
        e.vacation ||= inner.vacation;
        e.reject ||= inner.reject;
        e.local ||= inner.local;
        e.conflict ||= inner.conflict;
        mergeWrites(e.writes, inner.writes);
        // A loop iteration not visited could have evaluated this condition.
        if ((c instanceof CmdIf || c instanceof CmdElsif) && capturesRead && setsCaptures(c.test)) e.writes.captures = true;
        affects = inner.affects;
      } else if (c instanceof CmdKeep) {
        e.local = e.conflict = true;
        e.writes.flags ||= c.flags !== null;
      } else if (c instanceof CmdFileInto) {
        if (s.opts.maxFileintos > 0) e.local = e.conflict = true;
        e.writes.flags ||= c.flags !== null;
        affects = flagsRead && s.fileintosMayCap;
      } else if (c instanceof CmdRedirect) {
        e.conflict ||= s.opts.maxRedirects > 0;
        affects = s.redirectsMayCap;
      } else if (c instanceof CmdVacation) {
        e.vacation = e.conflict = true;
        affects = vacationsRepeat;
      } else if (c instanceof CmdDiscard) {
        e.writes.flags = true;
      } else if (c instanceof CmdSetFlag || c instanceof CmdAddFlag || c instanceof CmdRemoveFlag) {
        if (c.variableName !== null) e.writes.variables.add(c.variableName.toLowerCase());
        else e.writes.flags = true;
      } else if (c instanceof CmdSet || c instanceof CmdExtractText) {
        e.writes.variables.add(c.name.toLowerCase());
      } else if (c instanceof CmdAddHeader || c instanceof CmdDeleteHeader) {
        if (c.fieldName.includes("${")) e.writes.allHeaders = true;
        else e.writes.headers.add(c.fieldName.toLowerCase());
        if (c instanceof CmdDeleteHeader && capturesRead && c.valuePatterns.length > 0) e.writes.captures = true;
      } else {
        // stop, break, reject, and extension commands without a known effect
        // model retain the conservative control-flow barrier.
        if (c instanceof CmdReject) e.reject = true;
        const block = blockOf(c);
        if (block !== null) {
          const inner = mark(block);
          e.vacation ||= inner.vacation;
          e.reject ||= inner.reject;
          e.local ||= inner.local;
          e.conflict ||= inner.conflict;
          mergeWrites(e.writes, inner.writes);
        }
        affects = true;
      }
      e.affects ||= affects;
    }
    return e;
  };
  const effects = mark(s.cmds);
  s.hasLocalDelivery = effects.local;
  s.hasRejectConflictAction = effects.conflict;
}
