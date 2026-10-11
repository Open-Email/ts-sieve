// Actions — keep/fileinto/redirect/discard, plus flag canonicalisation.
// String arguments are expanded through RFC 5229 variables at execution time
// (expandVars is identity when the script does not require `variables`).

import { SieveError } from "../errors.js";
import { type Cmd, type RuntimeData, StopSignal } from "./runtime.js";
import { expandVars, expandVarsList, setVar } from "./variables.js";

/**
 * Normalise a flag list: split space-delimited flags, apply aliases, lowercase
 * (RFC 3501 flags are case-insensitive), dedupe, sort, and optionally remove.
 * Used for the INTERNAL flag set (`d.flags`), where order is irrelevant.
 */
export function canonicalFlags(
  src: string[],
  remove: string[] | null,
  aliases?: Map<string, string>,
): string[] {
  const fm = new Set<string>();
  for (const fl of src) {
    for (let f of fl.split(" ")) {
      if (f === "") continue; // RFC 5232: runs of whitespace yield no empty flag
      f = f.toLowerCase();
      fm.add(aliases?.get(f) ?? f);
    }
  }
  if (remove) {
    for (const fl of remove) {
      for (let f of fl.split(" ")) {
        if (f === "") continue;
        f = f.toLowerCase();
        fm.delete(aliases?.get(f) ?? f);
      }
    }
  }
  return [...fm].sort();
}

/**
 * Like {@link canonicalFlags} but ORDER-PRESERVING (RFC 5232 §5): flags keep
 * their first-occurrence order, empty tokens are dropped, and dedup/removal are
 * case-insensitive. This is the canonical form stored in a flag *variable* by the
 * `setflag/addflag/removeflag <variablename> …` form, so `${var}` reads back a
 * stable, deduped, space-separated flag string.
 */
function canonicalFlagsOrdered(
  src: string[],
  remove: string[] | null,
  aliases?: Map<string, string>,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const fl of src) {
    for (let f of fl.split(" ")) {
      if (f === "") continue;
      f = f.toLowerCase();
      f = aliases?.get(f) ?? f;
      if (!seen.has(f)) {
        seen.add(f);
        out.push(f);
      }
    }
  }
  if (remove) {
    for (const fl of remove) {
      for (let f of fl.split(" ")) {
        if (f === "") continue;
        f = f.toLowerCase();
        f = aliases?.get(f) ?? f;
        if (seen.delete(f)) {
          const i = out.indexOf(f);
          if (i !== -1) out.splice(i, 1);
        }
      }
    }
  }
  return out;
}

export class CmdStop implements Cmd {
  execute(_d: RuntimeData): void {
    throw new StopSignal();
  }
}

/** Each list's members, for addOnce. */
const members = new WeakMap<string[], Set<string>>();

/**
 * Append v to list unless it is there; false when it was. A Set answers, not a
 * scan of the list: in a loop, a message can drive fileinto to 100,000
 * distinct names, and scanning for each took 37 s at core's options. The Set
 * is rebuilt when the list's length shows it changed outside this function (a
 * host, or a clone, may push to it or replace it).
 */
function addOnce(list: string[], v: string): boolean {
  let seen = members.get(list);
  if (seen === undefined || seen.size !== list.length) {
    seen = new Set(list);
    members.set(list, seen);
  }
  if (seen.has(v)) return false;
  seen.add(v);
  list.push(v);
  return true;
}

export class CmdFileInto implements Cmd {
  mailbox = "";
  flags: string[] | null = null;
  copy = false; // RFC 3894 :copy
  create = false; // RFC 5490 :create

  execute(d: RuntimeData): void {
    const mailbox = expandVars(d, this.mailbox);
    if (!addOnce(d.mailboxes, mailbox)) return;
    if (this.create) addOnce(d.mailboxesCreate, mailbox);
    if (!this.copy) d.implicitKeep = false;
    if (this.flags !== null) {
      const flags = expandVarsList(d, this.flags);
      chargeFlags(d, flags);
      d.flags = canonicalFlags(flags, null, d.flagAliases);
    }
  }
}

export class CmdRedirect implements Cmd {
  addr = "";
  copy = false; // RFC 3894 :copy

  execute(d: RuntimeData): void {
    const addr = expandVars(d, this.addr);
    if (!d.policy.redirectAllowed(d, addr)) return;
    d.redirectAddr.push(addr);
    if (!this.copy) d.implicitKeep = false;
    if (d.redirectAddr.length > d.script.opts.maxRedirects) {
      throw new SieveError("too many actions");
    }
  }
}

export class CmdKeep implements Cmd {
  flags: string[] | null = null;

  execute(d: RuntimeData): void {
    d.keep = true; // keep does NOT cancel implicit keep
    if (this.flags !== null) {
      const flags = expandVarsList(d, this.flags);
      chargeFlags(d, flags);
      d.flags = canonicalFlags(flags, null, d.flagAliases);
    }
  }
}

export class CmdDiscard implements Cmd {
  execute(d: RuntimeData): void {
    d.implicitKeep = false;
    d.flags = [];
  }
}

/** Read a flag variable's current value as a flag-token list (RFC 5232 §5). */
function flagVar(d: RuntimeData, name: string): string[] {
  const v = d.variables.get(name.toLowerCase());
  return v ? [v] : [];
}

/**
 * Under a share of the budget (a foreverypart loop, or a test; see withShare),
 * charge flag work by the flags it handles, a step per 4 characters: each call
 * splits, folds and sorts every flag held as well as the new ones, some 40 ns
 * a flag, and in a loop the held set grows with each distinct flag a message
 * supplies (800 flags added 200,000 times took 15 s). A top-level command runs
 * once and is not charged, as for expandVars.
 */
export function chargeFlags(d: RuntimeData, ...lists: string[][]): void {
  if (d.budget.shares === 0) return;
  let n = 0;
  for (const l of lists) for (const f of l) n += f.length + 1;
  d.budget.consume(n >> 2);
}

export class CmdSetFlag implements Cmd {
  variableName: string | null = null; // null ⇒ the internal flag set
  flags: string[] | null = null;
  execute(d: RuntimeData): void {
    if (this.flags === null) return;
    const flags = expandVarsList(d, this.flags);
    chargeFlags(d, flags);
    if (this.variableName !== null) {
      setVar(d, this.variableName, canonicalFlagsOrdered(flags, null, d.flagAliases).join(" "));
    } else {
      d.flags = canonicalFlags(flags, null, d.flagAliases);
    }
  }
}

export class CmdAddFlag implements Cmd {
  variableName: string | null = null;
  flags: string[] | null = null;
  execute(d: RuntimeData): void {
    if (this.flags === null) return;
    const flags = expandVarsList(d, this.flags);
    if (this.variableName !== null) {
      chargeFlags(d, flagVar(d, this.variableName), flags);
      setVar(d, this.variableName, canonicalFlagsOrdered([...flagVar(d, this.variableName), ...flags], null, d.flagAliases).join(" "));
    } else {
      chargeFlags(d, d.flags, flags);
      d.flags = canonicalFlags([...d.flags, ...flags], null, d.flagAliases);
    }
  }
}

export class CmdRemoveFlag implements Cmd {
  variableName: string | null = null;
  flags: string[] | null = null;
  execute(d: RuntimeData): void {
    if (this.flags === null) return;
    const flags = expandVarsList(d, this.flags);
    if (this.variableName !== null) {
      chargeFlags(d, flagVar(d, this.variableName), flags);
      setVar(d, this.variableName, canonicalFlagsOrdered(flagVar(d, this.variableName), flags, d.flagAliases).join(" "));
    } else {
      chargeFlags(d, d.flags, flags);
      d.flags = canonicalFlags(d.flags, flags, d.flagAliases);
    }
  }
}
