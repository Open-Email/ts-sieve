// Actions — keep/fileinto/redirect/discard, plus flag canonicalisation.
// String arguments are expanded through RFC 5229 variables at execution time
// (expandVars is identity when the script does not require `variables`).

import { type Cmd, cutOffOnGuess, onGuess, type RuntimeData, StopSignal } from "./runtime.js";
import { expandMarked, expandVars, setVar } from "./variables.js";

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
  execute(d: RuntimeData): void {
    cutOffOnGuess(d);
    throw new StopSignal();
  }
}

/** A list's members by the key it is read with, and the list's length when
 * they were read (see memberSet). */
type Members = { keys: Set<string>; length: number };
const members = new WeakMap<string[], Members>();

/**
 * The keys of a list's members, answering membership without a scan: in a
 * loop, a message can drive fileinto to 100,000 distinct names, and scanning
 * for each took 37 s at core's options. Rebuilt when the list's length is not
 * the one recorded: a host, or a clone, may push to it or replace it (but not
 * edit an entry in place; see PolicyReader). The length is recorded, not read
 * off the set, so a duplicate a host pushed does not rebuild it on every call.
 * A list is always read with the same `key`.
 */
function memberSet(list: string[], key: (v: string) => string): Members {
  let m = members.get(list);
  if (m === undefined || m.length !== list.length) {
    m = { keys: new Set(list.map(key)), length: list.length };
    members.set(list, m);
  }
  return m;
}

/** Append v to list, its key to m. */
function append(m: Members, list: string[], v: string, key: string): void {
  m.keys.add(key);
  list.push(v);
  m.length = list.length;
}

const same = (v: string) => v;

export class CmdFileInto implements Cmd {
  mailbox = "";
  flags: string[] | null = null;
  copy = false; // RFC 3894 :copy
  create = false; // RFC 5490 :create

  execute(d: RuntimeData): void {
    const mailbox = expandVars(d, this.mailbox);
    const names = memberSet(d.mailboxes, same);
    // A repeat files nothing new (RFC 5228 §2.10.3), but its :create and
    // :flags apply as a first fileinto's would: the last flag list wins (RFC
    // 5232 §5).
    const held = names.keys.has(mailbox);
    if (!held && d.mailboxes.length >= d.script.opts.maxFileintos) {
      // Dropped, with nothing else it would have done, disclosed and counted:
      // inside a loop the message chooses how many targets there are (see
      // maxFileintos).
      d.indeterminate = true;
      d.fileintosDropped++;
      return;
    }
    // Expanded and charged before anything changes: in a loop a charge may
    // run out of the loop's share, and the command must then have done nothing.
    let flags: { flags: string[]; doubt: boolean } | null = null;
    if (this.flags !== null) {
      flags = flagsMarked(d, this.flags);
      chargeFlags(d, flags.flags);
    }
    if (!held) append(names, d.mailboxes, mailbox, mailbox);
    if (!this.copy) d.implicitKeep = false;
    if (this.create) {
      const created = memberSet(d.mailboxesCreate, same);
      if (!created.keys.has(mailbox)) append(created, d.mailboxesCreate, mailbox, mailbox);
    }
    if (flags !== null) setInternalFlags(d, flags.flags, flags.doubt);
  }
}

/**
 * What tells a redirect address's repeats: a bare address, its domain
 * lowercased (the local part is the receiving domain's to interpret). Anything
 * else, a display name, angle brackets, a quoted local part, a comment or a
 * group, is its own key: reading those by slicing merged different addresses,
 * and a host may read only the bare form, so a merge that keeps the other
 * spelling can lose the recipient. A missed merge costs one more target.
 */
function redirectKey(addr: string): string {
  const a = addr.trim();
  if (/[\s<>"()\\,;:[\]]/.test(a)) return addr;
  const at = a.lastIndexOf("@");
  return at === -1 ? a : a.slice(0, at) + a.slice(at).toLowerCase();
}

/** The redirect targets held only on a guess (see onGuess): no redirect to
 * them ran outside one. A forward cannot be recalled, so a host withholds
 * these and sends the rest. */
export function redirectsOnGuess(d: RuntimeData): string[] {
  if (d.redirectGuessed.size === 0) return [];
  return d.redirectAddr.filter((a) => d.redirectGuessed.has(redirectKey(a)));
}

export class CmdRedirect implements Cmd {
  addr = "";
  copy = false; // RFC 3894 :copy
  /** redirectKey(addr), for when the address is the literal itself. */
  private literalKey: string | null = null;

  execute(d: RuntimeData): void {
    const { value: addr, mark } = expandMarked(d, this.addr);
    // An address built from a value the engine could not hold whole is not
    // the whole input's address, and a forward cannot be recalled: dropped,
    // disclosed (see Mark) and counted, as the host never sees it.
    if (mark !== "") {
      d.indeterminate = true;
      d.redirectsDropped++;
      // The whole address may have delivered and conflicted with reject.
      // A limit of zero forbids even the whole address from being held.
      d.redirectUnresolved ||= d.script.opts.maxRedirects > 0;
      // Whole, it may have taken a slot under maxRedirects that a later
      // redirect takes here.
      if (d.script.redirectsMayCap) d.guessAfter = true;
      return;
    }
    // An address is redirected to once (as in Pigeonhole), and a repeat is no
    // new target: a loop redirecting once per matching part is not limited by
    // how many match. The host's policy is not asked again for an address it
    // allowed (one it refused is held nowhere, and is asked again).
    // A literal's key is computed once; an expansion was charged by its size.
    const key = addr === this.addr ? (this.literalKey ??= redirectKey(addr)) : redirectKey(addr);
    if (memberSet(d.redirectAddr, redirectKey).keys.has(key)) {
      if (!this.copy) d.implicitKeep = false;
      // A repeat outside a guess makes the target no guess.
      if (d.redirectGuessed.size > 0 && !onGuess(d)) d.redirectGuessed.delete(key);
      return;
    }
    if (d.redirectAddr.length >= d.script.opts.maxRedirects) {
      // Dropped, disclosed and counted, not thrown: a throw fails the whole
      // script, and a host's fail-open turns that into every rule skipped.
      d.indeterminate = true;
      d.redirectsDropped++;
      return;
    }
    if (!d.policy.redirectAllowed(d, addr)) return;
    // Read again: the policy may have appended to the list.
    const held = memberSet(d.redirectAddr, redirectKey);
    if (!held.keys.has(key)) {
      append(held, d.redirectAddr, addr, key);
      if (onGuess(d)) d.redirectGuessed.add(key);
    }
    if (!this.copy) d.implicitKeep = false;
  }
}

export class CmdKeep implements Cmd {
  flags: string[] | null = null;

  execute(d: RuntimeData): void {
    // Expanded and charged first, as for fileinto.
    const flags = this.flags === null ? null : flagsMarked(d, this.flags);
    if (flags !== null) chargeFlags(d, flags.flags);
    d.keep = true; // keep does NOT cancel implicit keep
    if (flags !== null) setInternalFlags(d, flags.flags, flags.doubt);
  }
}

export class CmdDiscard implements Cmd {
  execute(d: RuntimeData): void {
    d.implicitKeep = false;
    d.flags = [];
    d.flagsMarked = false;
  }
}

/** The flags a command names, expanded, and whether any came from a marked
 * value (see Mark): a canonical list rebuilt from one may differ anywhere, so
 * a flag variable or the internal set built from it is in doubt. */
function flagsMarked(d: RuntimeData, list: string[]): { flags: string[]; doubt: boolean; literal: boolean } {
  let doubt = false;
  const literal = list.every((f) => !f.includes("${"));
  const flags = list.map((f) => {
    const { value, mark } = expandMarked(d, f);
    if (mark !== "") doubt = true;
    return value;
  });
  return { flags, doubt, literal };
}

/** Replace the internal flag set, and its doubt with the list's (see
 * RuntimeData.flagsMarked): setflag, and the :flags of keep and fileinto. */
function setInternalFlags(d: RuntimeData, flags: string[], doubt: boolean): void {
  d.flags = canonicalFlags(flags, null, d.flagAliases);
  d.flagsMarked = doubt;
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
    const { flags, doubt, literal } = flagsMarked(d, this.flags);
    chargeFlags(d, flags);
    if (this.variableName !== null) {
      // A literal list is the script's own value: its cut is no mark (as set's).
      setVar(d, this.variableName, canonicalFlagsOrdered(flags, null, d.flagAliases).join(" "), doubt ? "doubt" : "", !literal);
    } else {
      setInternalFlags(d, flags, doubt);
    }
  }
}

export class CmdAddFlag implements Cmd {
  variableName: string | null = null;
  flags: string[] | null = null;
  execute(d: RuntimeData): void {
    if (this.flags === null) return;
    const { flags, doubt, literal } = flagsMarked(d, this.flags);
    if (this.variableName !== null) {
      chargeFlags(d, flagVar(d, this.variableName), flags);
      const held = d.varMarks.has(this.variableName.toLowerCase());
      // Its cut is always marked: even a literal list is joined onto a held
      // value, which may be the message's.
      setVar(d, this.variableName, canonicalFlagsOrdered([...flagVar(d, this.variableName), ...flags], null, d.flagAliases).join(" "), doubt || held ? "doubt" : "", true);
    } else {
      chargeFlags(d, d.flags, flags);
      d.flags = canonicalFlags([...d.flags, ...flags], null, d.flagAliases);
      d.flagsMarked ||= doubt;
    }
  }
}

export class CmdRemoveFlag implements Cmd {
  variableName: string | null = null;
  flags: string[] | null = null;
  execute(d: RuntimeData): void {
    if (this.flags === null) return;
    const { flags, doubt, literal } = flagsMarked(d, this.flags);
    if (this.variableName !== null) {
      chargeFlags(d, flagVar(d, this.variableName), flags);
      const held = d.varMarks.has(this.variableName.toLowerCase());
      setVar(d, this.variableName, canonicalFlagsOrdered(flagVar(d, this.variableName), flags, d.flagAliases).join(" "), doubt || held ? "doubt" : "", !literal || held);
    } else {
      chargeFlags(d, d.flags, flags);
      d.flags = canonicalFlags(d.flags, flags, d.flagAliases);
      d.flagsMarked ||= doubt;
    }
  }
}
