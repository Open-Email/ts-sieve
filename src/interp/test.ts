// The test AST nodes and their Check logic
// (address/allof/anyof/envelope/exists/false/true/header/not/size/hasflag),
// including the RFC 5231 `:count` accumulation and RFC 5260 `:index`/`:last`
// field selection on header/address.

import type { ReserveContext } from "./budget-reserve.js";
import { canonicalFlags, chargeFlags } from "./action.js";
import {
  parseEnvelopeAddress,
  splitAddress,
  splitSubaddress,
  SUBADDRESS_SEPARATOR,
} from "./address.js";
import { matchHeaderValue, valueMarks } from "./editheader.js";
import { getHeader } from "./header.js";
import { parseHeaderAddressesOnce } from "./header-values.js";
import type { MatchOptions } from "./matching.js";
import type { AddressPart } from "./matching.js";
import type { MatcherTest } from "./matcher.js";
import { type MimeOpts, type MimePart, partHeader } from "./mime.js";
import { doubtCaptures, provenLength, type Mark, type RuntimeData, type Test, type Tri } from "./runtime.js";
import { expandMarked, expandVars } from "./variables.js";

/** A header-list member may be unknown without doubting the other
 * members. Preserve an enclosing test's doubt, including MIME parameters. */
function headerMember(d: RuntimeData, template: string | { value: string; mark: Mark }, part?: MimePart): string[] | null {
  const { value: name, mark } = typeof template === "string" ? expandMarked(d, template) : template;
  if (mark !== "") return null;
  const outer = d.testDoubt;
  d.testDoubt = false;
  try {
    const values = part ? partHeader(d, part, name) : getHeader(d, name);
    return d.testDoubt ? null : values;
  } finally { d.testDoubt = outer; }
}
function doubtMatchCaptures(d: RuntimeData, matcher: MatcherTest): void {
  if (matcher.match === "matches" || matcher.match === "regex") doubtCaptures(d);
}

/** RFC 5260 §6 `:index`/`:last` — the positions [from, to) of the indexth
 * field instance (1-based) among `n`: all of them without :index. */
function indexRange(n: number, index: number, last: boolean): [number, number] {
  if (index <= 0) return [0, n];
  const idx = last ? n - index : index - 1;
  return idx >= 0 && idx < n ? [idx, idx + 1] : [0, 0];
}

function matchOpts(d: RuntimeData): MatchOptions {
  return { maxMatchInputLength: d.script.opts.maxMatchInputLength };
}

const allowedAddrHeaders = new Set([
  "from",
  "to",
  "cc",
  "bcc",
  "sender",
  "resent-from",
  "resent-to",
  "reply-to",
  "resent-reply-to",
  "resent-sender",
  "resent-cc",
  "resent-bcc",
  "for-approval",
  "for-handling",
  "for-comment",
  "apparently-to",
  "errors-to",
  "delivered-to",
  "return-receipt-to",
  "x-admin",
  "read-receipt-to",
  "x-confirm-reading-to",
  "return-receipt-requested",
  "registered-mail-reply-requested-by",
  "mail-followup-to",
  "mail-reply-to",
  "abuse-reports-to",
  "x-complaints-to",
  "x-report-abuse-to",
  "x-beenthere",
  "x-original-from",
  "x-original-to",
]);

function testAddress(
  d: RuntimeData,
  matcher: MatcherTest,
  part: AddressPart,
  address: string,
): Tri {
  if (address === "<>") address = "";

  let valueToCompare = "";
  if (address !== "") {
    switch (part) {
      case "localpart": {
        try {
          valueToCompare = splitAddress(address).mailbox;
        } catch {
          return false;
        }
        break;
      }
      case "domain": {
        try {
          valueToCompare = splitAddress(address).domain;
        } catch {
          return false;
        }
        break;
      }
      case "all":
        valueToCompare = address;
        break;
      case "user": {
        let localPart: string;
        try {
          localPart = splitAddress(address).mailbox;
        } catch {
          return false;
        }
        valueToCompare = splitSubaddress(localPart).user;
        break;
      }
      case "detail": {
        let localPart: string;
        try {
          localPart = splitAddress(address).mailbox;
        } catch {
          return false;
        }
        const { detail } = splitSubaddress(localPart);
        if (detail === "" && !localPart.includes(SUBADDRESS_SEPARATOR)) return false;
        valueToCompare = detail;
        break;
      }
    }
  }

  return matcher.tryMatch(d, valueToCompare, matchOpts(d));
}

/**
 * Whether a test runs inside a foreverypart loop, where it runs once per part
 * and what it reads multiplies with the iterations: there it is charged by the
 * values it finds and their size. At top level a test runs once, its reads
 * bounded by the message and the script; a charge there by size or by count
 * would let a large or repeated header, with a body test that spends the
 * budget, cost the rules after it their reserve, a way for a message to skip
 * them.
 */
function inLoop(d: RuntimeData): boolean {
  return d.partStack.length > 0;
}

/**
 * Charge parsing a field's values as addresses: a step for the field name,
 * and where sized (in a loop) one per value and a step per 64 characters
 * parsed (some 12 ns a character). At top level a message sets how many
 * values there are by repeating a header, and each is probed for a step anyway. A test names any number of fields, which a loop repeats:
 * charged nothing per name, 1,000 names over an 8 KB From cost 18 ms a step.
 * Tests run under a share of the budget (withShare), so running out is
 * "unknown".
 */
function chargeRead(d: RuntimeData, values: readonly string[], sized = inLoop(d)): void {
  let n = 1;
  if (sized) for (const v of values) n += 1 + (v.length >> 6);
  d.budget.consume(n);
}

/** Potential RFC 2047 words: decoding can resume two characters into a failed
 * candidate. Count framed candidates conservatively, allowing "?" in their
 * text (#75). Cache the next closing marker so overlapping failed candidates
 * do not repeatedly scan the same suffix; bare "=?" is only a search cost. */
function encodedWords(v: string): number {
  if (/[\r\n]/.test(v)) v = v.replace(/[\r\n]/g, "");
  const prefix = /=\?[^?]*\?[bBqQ]\?/g;
  let n = 0;
  let closeAt = -1;
  for (let m = prefix.exec(v); m !== null; m = prefix.exec(v)) {
    if (closeAt < prefix.lastIndex) closeAt = v.indexOf("?=", prefix.lastIndex);
    if (closeAt === -1) break;
    n++;
    prefix.lastIndex = m.index + 2;
  }
  return n;
}

/** What decodeHeaderValue costs, charged in a loop (see inLoop): a scan of the
 * value (a step per 2 KiB); a step per 64 characters when it holds CR or LF
 * to strip, or "=?" for the decoder to search; and a step per encoded word it
 * tries, each a decoder (some 0.6 us, however small). */
function decodeCost(v: string): number {
  let n = v.length >> 11;
  const searched = v.includes("=?");
  if (searched || /[\r\n]/.test(v)) n += v.length >> 6;
  if (searched) n += encodedWords(v);
  return n;
}

export class AddressTest implements Test {
  index = 0; // RFC 5260 :index (0 = all fields)
  last = false;
  /** RFC 5703 §4.2 :mime / :anychild; null without :mime. */
  mime: MimeOpts | null = null;

  constructor(
    readonly matcher: MatcherTest,
    public addressPart: AddressPart,
    public header: string[],
  ) {}

  budgetReserve(context: ReserveContext): number | undefined {
    if (this.mime?.enabled) return undefined;
    context.names(this.header.length);
    let cost = 2 + this.header.length;
    for (const name of this.header) {
      if (!name.includes("${") && !allowedAddrHeaders.has(name.toLowerCase())) continue;
      const values = context.header(name, this.index, this.last);
      if (values === undefined) return undefined;
      const match = this.matcher.reserveFor(values, true);
      if (match === undefined) return undefined;
      cost += match;
    }
    return cost;
  }

  check(d: RuntimeData): Tri {
    const state = { entryCount: 0, unknown: false };
    if (this.mime?.enabled) {
      // RFC 5703 §4.2: any header of the parts in scope is read as an address
      // header, so the address-header allow-list does not apply.
      const { parts, open } = this.mime.scope(d);
      for (const part of parts) {
        for (const hdr of this.header) {
          const values = headerMember(d, hdr, part);
          if (values === null) { d.budget.consume(1); state.unknown = true; doubtMatchCaptures(d, this.matcher); continue; }
          // Parsing each value as addresses costs its size, wherever the test
          // runs: a part's header is not capped as the message's are, and
          // :anychild multiplies the parts read.
          chargeRead(d, values, true);
          // :index counts the fields of the part's own header (see
          // HeaderTest.checkMime).
          const [from, to] = indexRange(values.length, this.index, this.last);
          if (this.matchValues(d, values.slice(from, to), valueMarks(values)?.slice(from, to), state)) return true;
        }
      }
      if (this.matcher.isCount()) return state.unknown ? "unknown" : countOver(d, this.matcher, state.entryCount, open);
      return state.unknown || open ? "unknown" : false;
    }
    for (const template of this.header) {
      const expanded = expandMarked(d, template);
      if (expanded.mark !== "") { d.budget.consume(1); state.unknown = true; doubtMatchCaptures(d, this.matcher); continue; }
      if (!allowedAddrHeaders.has(expanded.value.toLowerCase())) {
        d.budget.consume(1);
        continue;
      }
      const all = headerMember(d, expanded);
      if (all === null) { d.budget.consume(1); state.unknown = true; doubtMatchCaptures(d, this.matcher); continue; }
      chargeRead(d, all);
      const [from, to] = indexRange(all.length, this.index, this.last);
      if (this.matchValues(d, all.slice(from, to), valueMarks(all)?.slice(from, to), state)) return true;
    }
    if (this.matcher.isCount()) return state.unknown ? "unknown" : this.matcher.countMatches(d, state.entryCount);
    return state.unknown ? "unknown" : false;
  }

  /** One header's values: true on a definite match. Counts addresses into
   * `state.entryCount` under :count; an unknown lands in `state.unknown`.
   * Header values are complete, so unknowns here come from the engine's
   * match-input cap on an oversized value, and from a value an addheader
   * built from a marked one (`marks`, see valueMarks): a prefix of an address
   * list may end inside a quoted name or a comment, so it proves nothing, and
   * its addresses are not counted. */
  private matchValues(d: RuntimeData, values: string[], marks: readonly Mark[] | undefined, state: { entryCount: number; unknown: boolean }): boolean {
    // "unknown" is truthy as a string — never `if (tryMatch(...))` a Tri;
    // accumulate through this probe instead.
    const probe = (address: string): boolean => {
      const r = testAddress(d, this.matcher, this.addressPart, address);
      if (r === "unknown") { state.unknown = true; doubtMatchCaptures(d, this.matcher); }
      return r === true;
    };
    if (values.length === 0) return !this.matcher.isCount() && probe("");
    for (let i = 0; i < values.length; i++) {
      if ((marks?.[i] ?? "") !== "") {
        state.unknown = true;
        doubtMatchCaptures(d, this.matcher);
        continue;
      }
      // A bare angle-addr ("<user@example.com>") is a valid mailbox (RFC 5322
      // §3.4: name-addr = [display-name] angle-addr), and a non-ASCII local
      // part is accepted in it as in every other form (RFC 6532).
      const { clean: cleanValue, addresses: addrList } = parseHeaderAddressesOnce(d, values[i]!);
      if (addrList === null) {
        if (this.matcher.isCount()) continue;
        if (probe(cleanValue)) return true;
        continue;
      }

      if (addrList.length === 0) {
        if (this.matcher.isCount()) continue;
        if (probe("")) return true;
        continue;
      }

      for (const addr of addrList) {
        if (this.matcher.isCount()) {
          state.entryCount++;
          continue;
        }
        if (probe(addr.address)) return true;
      }
    }
    return false;
  }
}

export class EnvelopeTest implements Test {
  constructor(
    readonly matcher: MatcherTest,
    public addressPart: AddressPart,
    public field: string[],
  ) {}

  check(d: RuntimeData): Tri {
    let entryCount = 0;
    let unknown = false;
    for (const field of this.field) {
      d.budget.consume(1);
      const name = expandVars(d, field).toLowerCase();
      let value: string;
      switch (name) {
        case "from":
          value = d.envelope.envelopeFrom();
          break;
        case "to":
          value = d.envelope.envelopeTo();
          break;
        case "auth":
          value = d.envelope.authUsername();
          break;
        default:
          // Known only now (a literal one fails at load): the part may come
          // from the message, and a throw would skip every rule. It has no
          // value, like a header the message does not have.
          continue;
      }

      if (value !== "" && (name === "from" || name === "to")) {
        try {
          parseEnvelopeAddress(value);
        } catch {
          continue; // invalid envelope address — matches nothing
        }
      }

      if (this.matcher.isCount()) {
        if (value !== "") entryCount++;
        continue;
      }

      const r = testAddress(d, this.matcher, this.addressPart, value);
      if (r === true) return true;
      if (r === "unknown") unknown = true;
    }
    if (this.matcher.isCount()) return this.matcher.countMatches(d, entryCount);
    return unknown ? "unknown" : false;
  }
}

export class ExistsTest implements Test {
  /** It sets no captures (see setsCaptures). */
  readonly setsCaptures = false;
  /** RFC 5703 §4.3 :mime / :anychild; null without :mime. */
  mime: MimeOpts | null = null;

  constructor(public fields: string[]) {}
  check(d: RuntimeData): Tri {
    if (this.mime?.enabled) {
      // Each field in some part in scope (Pigeonhole: not all in one part).
      // Missing from a scope that may go on past the cut, it is unknown.
      const { parts, open } = this.mime.scope(d);
      let unknown = false;
      for (const field of this.fields) {
        const name = expandVars(d, field);
        d.budget.consume(1 + parts.length);
        if (parts.some((p) => partHeader(d, p, name).length > 0)) continue;
        if (!open) return false;
        unknown = true;
      }
      return unknown ? "unknown" : true;
    }
    for (const field of this.fields) {
      const values = getHeader(d, expandVars(d, field));
      d.budget.consume(1 + (inLoop(d) ? values.length : 0)); // the name; in a loop, the values found
      if (values.length === 0) return false;
    }
    return true;
  }
}

export class FalseTest implements Test {
  /** It sets no captures (see setsCaptures). */
  readonly setsCaptures = false;
  check(): boolean {
    return false;
  }
}

export class TrueTest implements Test {
  /** It sets no captures (see setsCaptures). */
  readonly setsCaptures = false;
  check(): boolean {
    return true;
  }
}

export class HeaderTest implements Test {
  index = 0; // RFC 5260 :index (0 = all fields)
  last = false;

  /** RFC 5703 §4.1 :mime and its options; null without :mime. */
  mime: MimeOpts | null = null;

  constructor(
    readonly matcher: MatcherTest,
    public header: string[],
  ) {}

  budgetReserve(context: ReserveContext): number | undefined {
    if (this.mime?.enabled) return undefined;
    context.names(this.header.length);
    let cost = 2 + this.header.length;
    for (const name of this.header) {
      const values = context.header(name, this.index, this.last);
      if (values === undefined) return undefined;
      const match = this.matcher.reserveFor(values);
      if (match === undefined) return undefined;
      cost += match;
    }
    return cost;
  }

  check(d: RuntimeData): Tri {
    if (this.mime?.enabled) return this.checkMime(d, this.mime);
    let entryCount = 0;
    let unknown = false;
    for (const hdr of this.header) {
      const all = headerMember(d, hdr);
      if (all === null) { d.budget.consume(1); unknown = true; doubtMatchCaptures(d, this.matcher); continue; }
      d.budget.consume(1 + (inLoop(d) ? all.length : 0)); // the name; in a loop, the values found
      const marks = valueMarks(all);
      const [from, to] = indexRange(all.length, this.index, this.last);
      for (let i = from; i < to; i++) {
        // A marked value is still a field: :count counts it.
        if (this.matcher.isCount()) {
          entryCount++;
          continue;
        }
        const value = all[i]!;
        if (inLoop(d)) d.budget.consume(decodeCost(value));
        const r = matchHeaderValue(d, this.matcher, value, marks?.[i] ?? "", matchOpts(d));
        if (r === true) return true;
        if (r === "unknown") { unknown = true; doubtMatchCaptures(d, this.matcher); }
      }
    }
    if (this.matcher.isCount()) return unknown ? this.matcher.matchAtLeast(d, entryCount) : this.matcher.countMatches(d, entryCount);
    return unknown ? "unknown" : false;
  }

  /** The fields of every part in scope :index selects, through the MIMEOPT.
   * Over a scope that may go on past the read-window cut, a miss is unknown. */
  private checkMime(d: RuntimeData, mime: MimeOpts): Tri {
    const { parts, open } = mime.scope(d);
    const params = mime.params.map((p) => expandVars(d, p));
    let entryCount = 0;
    let unknown = false;
    // A value an addheader built from a marked one (see valueMarks) is left
    // out of what the MIMEOPT derives: what it would read there is unknown,
    // under :count too.
    let marked = false;
    for (const part of parts) {
      for (const hdr of this.header) {
        const expanded = expandMarked(d, hdr);
        const name = expanded.value;
        d.budget.consume(1); // the name; mime.values charges each value
        const all = headerMember(d, expanded, part);
        if (all === null) { marked = true; doubtMatchCaptures(d, this.matcher); continue; }
        // Each part in scope is tested on its own (RFC 5703 §4.1: the test is
        // true if any of them satisfies it), so :index counts the fields of
        // the part's own header, as it counts the message's; Pigeonhole
        // counts the values the MIMEOPT derives, across the parts. :count
        // still sums over the parts: it counts the values the test reads,
        // which under :anychild are every part's, as Pigeonhole counts them.
        // Without :index, a MIMEOPT on Content-Type or Content-Disposition
        // reads the first field (see MimeOpts.firstOnly), picked before a
        // marked one is set aside, so a first field in doubt is not passed
        // over for the next.
        const [from, to] = this.index === 0 && mime.firstOnly(name) ? [0, Math.min(1, all.length)] : indexRange(all.length, this.index, this.last);
        let raw = from === 0 && to === all.length ? all : all.slice(from, to);
        const marks = valueMarks(all)?.slice(from, to);
        if (marks?.some((m) => m !== "")) {
          marked = true;
          doubtMatchCaptures(d, this.matcher);
          raw = raw.filter((_, i) => marks[i] === "");
        }
        const values = mime.values(d, name, raw, params);
        if (this.matcher.isCount()) {
          entryCount += values.length;
          continue;
        }
        for (const value of values) {
          const r = this.matcher.tryMatch(d, value, matchOpts(d));
          if (r === true) return true;
          if (r === "unknown") { unknown = true; doubtMatchCaptures(d, this.matcher); }
        }
      }
    }
    if (this.matcher.isCount()) return marked || open ? this.matcher.matchAtLeast(d, entryCount) : this.matcher.countMatches(d, entryCount);
    return unknown || open || marked ? "unknown" : false;
  }
}

/** A :count over a scope that may go on past the cut is a lower bound:
 * "ge"/"gt" proven stay proven, anything else is unknown. */
function countOver(d: RuntimeData, matcher: MatcherTest, count: number, open: boolean): Tri {
  const res = matcher.countMatches(d, count);
  if (!open) return res;
  return res && (matcher.relational === "ge" || matcher.relational === "gt") ? true : "unknown";
}

// Kleene logic (RFC 5228 booleans widened by "unknown" — see runtime.ts's Tri):
// not(unknown) = unknown; a definite false absorbs unknowns in allof and a
// definite true absorbs them in anyof, so evaluation continues PAST an unknown
// member looking for the absorbing value rather than short-circuiting into a
// guess. Only when no member decides does the unknown surface.

/** Whether a test can leave captures the script sees: the body test restores
 * its own, exists, size and the like set none, and not, allof and anyof answer
 * for their members. A test that does not say is assumed to. */
export function setsCaptures(t: Test): boolean {
  return (t as { setsCaptures?: boolean }).setsCaptures !== false;
}

/**
 * One member of anyof/allof, with what its answer means for the captures.
 * A member that answers definitely answers alike over the whole input, so an
 * unknown inside it (another value, a body part) doubts nothing after it. An
 * unknown member doubts the captures in force, unless it could not have set
 * any; either way it doubts what the members after it set.
 */
function member(d: RuntimeData, t: Test): Tri {
  const before = d.captureDoubt;
  const r = t.check(d);
  if (r !== "unknown") d.captureDoubt = before;
  else if (setsCaptures(t)) doubtCaptures(d);
  else d.captureDoubt = true;
  return r;
}

export class NotTest implements Test {
  constructor(public test: Test) {}
  /** Its test's (see setsCaptures). */
  get setsCaptures(): boolean {
    return setsCaptures(this.test);
  }
  check(d: RuntimeData): Tri {
    const r = this.test.check(d);
    return r === "unknown" ? "unknown" : !r;
  }
}

export class AllOfTest implements Test {
  constructor(public tests: Test[]) {}
  /** Whether a member may (see setsCaptures). */
  get setsCaptures(): boolean {
    return this.tests.some(setsCaptures);
  }
  check(d: RuntimeData): Tri {
    let unknown = false;
    for (const t of this.tests) {
      const r = member(d, t);
      if (r === false) return false;
      if (r === "unknown") unknown = true;
    }
    return unknown ? "unknown" : true;
  }
}

export class AnyOfTest implements Test {
  constructor(public tests: Test[]) {}
  /** Whether a member may (see setsCaptures). */
  get setsCaptures(): boolean {
    return this.tests.some(setsCaptures);
  }
  check(d: RuntimeData): Tri {
    let unknown = false;
    for (const t of this.tests) {
      const r = member(d, t);
      if (r === true) return true;
      if (r === "unknown") unknown = true;
    }
    return unknown ? "unknown" : false;
  }
}

/**
 * RFC 5232 §5 `hasflag` test. With no variable-list, it inspects the internal
 * flag set built up by setflag/addflag/removeflag; with a variable-list (needs
 * `variables`), it inspects the canonicalised union of those variables' values.
 * `:count` compares the number of flags in the inspected set. (Added here to
 * complete imap4flags.)
 */
export class HasFlagTest implements Test {
  constructor(
    readonly matcher: MatcherTest,
    public variables: string[], // variable names; empty = internal flag set
  ) {}

  check(d: RuntimeData): Tri {
    let flags: string[];
    let unknown = false;
    if (this.variables.length > 0) {
      const lists = this.variables.map((v) => {
        const name = v.toLowerCase();
        const value = d.variables.get(name) ?? "";
        const mark = d.varMarks.get(name) ?? "";
        if (mark === "") return value;
        unknown = true;
        const head = value.slice(0, provenLength(value, mark));
        // Only space-terminated tokens are complete before a possible tail.
        return head.slice(0, head.lastIndexOf(" ") + 1);
      });
      chargeFlags(d, lists);
      flags = canonicalFlags(lists, null, d.flagAliases).filter((f) => f !== "");
    } else {
      unknown = d.flagsMarked;
      // Unobserved writes could have removed any internal flag.
      flags = unknown ? [] : d.flags;
    }
    if (this.matcher.isCount()) return unknown ? this.matcher.matchAtLeast(d, flags.length) : this.matcher.countMatches(d, flags.length);
    if (unknown) doubtMatchCaptures(d, this.matcher);
    for (const f of flags) {
      const r = this.matcher.tryMatch(d, f, matchOpts(d));
      if (r === true) return true;
      if (r === "unknown") unknown = true;
    }
    return unknown ? "unknown" : false;
  }

}

export class SizeTest implements Test {
  /** It sets no captures (see setsCaptures). */
  readonly setsCaptures = false;
  constructor(
    public size: number,
    public over: boolean,
    public under: boolean,
  ) {}
  check(d: RuntimeData): boolean {
    if (this.over && d.msg.messageSize() > this.size) return true;
    if (this.under && d.msg.messageSize() < this.size) return true;
    return false;
  }
}
