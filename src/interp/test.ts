// The test AST nodes and their Check logic
// (address/allof/anyof/envelope/exists/false/true/header/not/size/hasflag),
// including the RFC 5231 `:count` accumulation and RFC 5260 `:index`/`:last`
// field selection on header/address.

import { canonicalFlags, chargeFlags } from "./action.js";
import {
  parseAddressList,
  parseEnvelopeAddress,
  splitAddress,
  splitSubaddress,
  stripRFC2822Comments,
  SUBADDRESS_SEPARATOR,
} from "./address.js";
import { getHeader, decodeHeaderValue } from "./header.js";
import type { MatchOptions } from "./matching.js";
import type { AddressPart } from "./matching.js";
import type { MatcherTest } from "./matcher.js";
import { type MimeOpts, partHeader } from "./mime.js";
import type { RuntimeData, Test, Tri } from "./runtime.js";
import { expandVars } from "./variables.js";

/** RFC 5260 §6 `:index`/`:last` — select the indexth field instance (1-based). */
function selectIndexed(values: string[], index: number, last: boolean): string[] {
  if (index <= 0) return values;
  const idx = last ? values.length - index : index - 1;
  return idx >= 0 && idx < values.length ? [values[idx]!] : [];
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
 * and the size of what it reads multiplies with the iterations: there it is
 * charged by size. At top level a test runs once, its reads bounded by the
 * message and the script; a size charge there would let a large header, with
 * a body test that spends the budget, cost the rules after it their reserve,
 * a way for a message to skip them.
 */
function inLoop(d: RuntimeData): boolean {
  return d.partStack.length > 0;
}

/**
 * Charge parsing a field's values as addresses: a step for the field name and
 * one per value, and in a loop a step per 64 characters parsed (some 12 ns a
 * character). A test names any number of fields, which a loop repeats:
 * charged nothing per name, 1,000 names over an 8 KB From cost 18 ms a step.
 * Tests run under a share of the budget (withShare), so running out is
 * "unknown".
 */
function chargeRead(d: RuntimeData, values: readonly string[], sized = inLoop(d)): void {
  let n = 1;
  for (const v of values) n += 1 + (sized ? v.length >> 6 : 0);
  d.budget.consume(n);
}

/** RFC 2047 encoded words, as decodeHeaderValue finds them. */
const ENCODED_WORD = /=\?[^?]+\?[bBqQ]\?[^?]*\?=/g;

/** What decodeHeaderValue costs, charged in a loop (see inLoop): a scan of the
 * value (a step per 2 KiB); a step per 64 characters when it holds CR or LF
 * to strip, or "=?" for the decoder to search; and a step per encoded word it
 * decodes, each a callback and a decoder (some 0.6 us, however small). */
function decodeCost(v: string): number {
  let n = v.length >> 11;
  const searched = v.includes("=?");
  if (searched || /[\r\n]/.test(v)) n += v.length >> 6;
  if (searched) n += v.match(ENCODED_WORD)?.length ?? 0;
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

  check(d: RuntimeData): Tri {
    const state = { entryCount: 0, unknown: false };
    if (this.mime?.enabled) {
      // RFC 5703 §4.2: any header of the parts in scope is read as an address
      // header, so the address-header allow-list does not apply.
      const { parts, open } = this.mime.scope(d);
      for (const part of parts) {
        for (const hdr of this.header) {
          const values = partHeader(d, part, expandVars(d, hdr));
          // Parsing each value as addresses costs its size, wherever the test
          // runs: a part's header is not capped as the message's are, and
          // :anychild multiplies the parts read.
          chargeRead(d, values, true);
          if (this.matchValues(d, values, state)) return true;
        }
      }
      if (this.matcher.isCount()) return countOver(d, this.matcher, state.entryCount, open);
      return state.unknown || open ? "unknown" : false;
    }
    for (let hdr of this.header) {
      hdr = expandVars(d, hdr).toLowerCase();
      if (!allowedAddrHeaders.has(hdr)) {
        d.budget.consume(1);
        continue;
      }
      const all = getHeader(d, hdr);
      chargeRead(d, all);
      if (this.matchValues(d, selectIndexed(all, this.index, this.last), state)) return true;
    }
    if (this.matcher.isCount()) return this.matcher.countMatches(d, state.entryCount);
    return state.unknown ? "unknown" : false;
  }

  /** One header's values: true on a definite match. Counts addresses into
   * `state.entryCount` under :count; an unknown lands in `state.unknown`.
   * Header values are complete, so unknowns here come only from the engine's
   * match-input cap on an oversized value. */
  private matchValues(d: RuntimeData, values: string[], state: { entryCount: number; unknown: boolean }): boolean {
    // "unknown" is truthy as a string — never `if (tryMatch(...))` a Tri;
    // accumulate through this probe instead.
    const probe = (address: string): boolean => {
      const r = testAddress(d, this.matcher, this.addressPart, address);
      if (r === "unknown") state.unknown = true;
      return r === true;
    };
    if (values.length === 0) return !this.matcher.isCount() && probe("");
    for (const value of values) {
      const cleanValue = stripRFC2822Comments(value);

      // A bare angle-addr ("<user@example.com>") is a valid mailbox (RFC 5322
      // §3.4: name-addr = [display-name] angle-addr), and a non-ASCII local
      // part is accepted in it as in every other form (RFC 6532).
      let addrList: { address: string }[];
      try {
        addrList = parseAddressList(cleanValue);
      } catch {
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
      d.budget.consume(1 + values.length); // the name, and the values found
      if (values.length === 0) return false;
    }
    return true;
  }
}

export class FalseTest implements Test {
  check(): boolean {
    return false;
  }
}

export class TrueTest implements Test {
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

  check(d: RuntimeData): Tri {
    if (this.mime?.enabled) return this.checkMime(d, this.mime);
    let entryCount = 0;
    let unknown = false;
    for (const hdr of this.header) {
      const all = getHeader(d, expandVars(d, hdr));
      d.budget.consume(1 + all.length); // the name, and the values found
      const values = selectIndexed(all, this.index, this.last);
      for (const value of values) {
        if (this.matcher.isCount()) {
          entryCount++;
          continue;
        }
        if (inLoop(d)) d.budget.consume(decodeCost(value));
        const r = this.matcher.tryMatch(d, decodeHeaderValue(value), matchOpts(d));
        if (r === true) return true;
        if (r === "unknown") unknown = true;
      }
    }
    if (this.matcher.isCount()) return this.matcher.countMatches(d, entryCount);
    return unknown ? "unknown" : false;
  }

  /** The fields of every part in scope, through the MIMEOPT. Over a scope that
   * may go on past the read-window cut, a miss is unknown. */
  private checkMime(d: RuntimeData, mime: MimeOpts): Tri {
    const { parts, open } = mime.scope(d);
    const params = mime.params.map((p) => expandVars(d, p));
    let entryCount = 0;
    let unknown = false;
    for (const part of parts) {
      for (const hdr of this.header) {
        const name = expandVars(d, hdr);
        d.budget.consume(1); // the name; mime.values charges each value
        const values = mime.values(d, name, partHeader(d, part, name), params);
        if (this.matcher.isCount()) {
          entryCount += values.length;
          continue;
        }
        for (const value of values) {
          const r = this.matcher.tryMatch(d, value, matchOpts(d));
          if (r === true) return true;
          if (r === "unknown") unknown = true;
        }
      }
    }
    if (this.matcher.isCount()) return countOver(d, this.matcher, entryCount, open);
    return unknown || open ? "unknown" : false;
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

export class NotTest implements Test {
  constructor(public test: Test) {}
  check(d: RuntimeData): Tri {
    const r = this.test.check(d);
    return r === "unknown" ? "unknown" : !r;
  }
}

export class AllOfTest implements Test {
  constructor(public tests: Test[]) {}
  check(d: RuntimeData): Tri {
    let unknown = false;
    for (const t of this.tests) {
      const r = t.check(d);
      if (r === false) return false;
      if (r === "unknown") unknown = true;
    }
    return unknown ? "unknown" : true;
  }
}

export class AnyOfTest implements Test {
  constructor(public tests: Test[]) {}
  check(d: RuntimeData): Tri {
    let unknown = false;
    for (const t of this.tests) {
      const r = t.check(d);
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
    if (this.variables.length > 0) {
      const lists = this.variables.map((v) => d.variables.get(v.toLowerCase()) ?? "");
      chargeFlags(d, lists);
      flags = canonicalFlags(lists, null, d.flagAliases).filter((f) => f !== "");
    } else {
      flags = d.flags;
    }
    if (this.matcher.isCount()) return this.matcher.countMatches(d, flags.length);
    let unknown = false;
    for (const f of flags) {
      const r = this.matcher.tryMatch(d, f, matchOpts(d));
      if (r === true) return true;
      if (r === "unknown") unknown = true;
    }
    return unknown ? "unknown" : false;
  }
}

export class SizeTest implements Test {
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
