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
export function canonicalFlagsOrdered(
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

export class CmdFileInto implements Cmd {
  mailbox = "";
  flags: string[] | null = null;
  copy = false; // RFC 3894 :copy
  create = false; // RFC 5490 :create

  execute(d: RuntimeData): void {
    const mailbox = expandVars(d, this.mailbox);
    if (d.mailboxes.includes(mailbox)) return;
    d.mailboxes.push(mailbox);

    if (this.create && !d.mailboxesCreate.includes(mailbox)) {
      d.mailboxesCreate.push(mailbox);
    }
    if (!this.copy) d.implicitKeep = false;
    if (this.flags !== null) d.flags = canonicalFlags(expandVarsList(d, this.flags), null, d.flagAliases);
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
    if (this.flags !== null) d.flags = canonicalFlags(expandVarsList(d, this.flags), null, d.flagAliases);
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

export class CmdSetFlag implements Cmd {
  variableName: string | null = null; // null ⇒ the internal flag set
  flags: string[] | null = null;
  execute(d: RuntimeData): void {
    if (this.flags === null) return;
    const flags = expandVarsList(d, this.flags);
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
      setVar(d, this.variableName, canonicalFlagsOrdered([...flagVar(d, this.variableName), ...flags], null, d.flagAliases).join(" "));
    } else {
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
      setVar(d, this.variableName, canonicalFlagsOrdered(flagVar(d, this.variableName), flags, d.flagAliases).join(" "));
    } else {
      d.flags = canonicalFlags(d.flags, flags, d.flagAliases);
    }
  }
}
