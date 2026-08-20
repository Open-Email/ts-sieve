// The test AST nodes and their Check logic
// (address/allof/anyof/envelope/exists/false/true/header/not/size/hasflag),
// including the RFC 5231 `:count` accumulation and RFC 5260 `:index`/`:last`
// field selection on header/address.

import { SieveError } from "../errors.js";
import { canonicalFlags } from "./action.js";
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

export class AddressTest implements Test {
  index = 0; // RFC 5260 :index (0 = all fields)
  last = false;

  constructor(
    readonly matcher: MatcherTest,
    public addressPart: AddressPart,
    public header: string[],
  ) {}

  check(d: RuntimeData): Tri {
    let entryCount = 0;
    let unknown = false;
    // Header values are complete, so unknowns here come only from the engine's
    // match-input cap on an oversized value. "unknown" is truthy as a string —
    // never `if (tryMatch(...))` a Tri; accumulate through this probe instead.
    const probe = (address: string): boolean => {
      const r = testAddress(d, this.matcher, this.addressPart, address);
      if (r === "unknown") unknown = true;
      return r === true;
    };
    for (let hdr of this.header) {
      hdr = expandVars(d, hdr).toLowerCase();
      if (!allowedAddrHeaders.has(hdr)) continue;

      const values = selectIndexed(getHeader(d, hdr), this.index, this.last);
      if (values.length === 0) {
        if (this.matcher.isCount()) continue;
        if (probe("")) return true;
        continue;
      }

      for (const value of values) {
        const cleanValue = stripRFC2822Comments(value);

        const trimmed = cleanValue.trim();
        const bareAngle =
          trimmed.startsWith("<") &&
          trimmed.endsWith(">") &&
          (trimmed.match(/</g) ?? []).length === 1 &&
          (trimmed.match(/>/g) ?? []).length === 1;
        if (bareAngle) {
          if (this.matcher.isCount()) continue;
          if (probe(cleanValue)) return true;
          continue;
        }

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
            entryCount++;
            continue;
          }
          if (probe(addr.address)) return true;
        }
      }
    }
    if (this.matcher.isCount()) return this.matcher.countMatches(d, entryCount);
    return unknown ? "unknown" : false;
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
          throw new SieveError(`envelope: unsupported envelope-part: ${field}`);
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
  constructor(public fields: string[]) {}
  check(d: RuntimeData): boolean {
    for (const field of this.fields) {
      if (getHeader(d, expandVars(d, field)).length === 0) return false;
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

  constructor(
    readonly matcher: MatcherTest,
    public header: string[],
  ) {}

  check(d: RuntimeData): Tri {
    let entryCount = 0;
    let unknown = false;
    for (const hdr of this.header) {
      const values = selectIndexed(getHeader(d, expandVars(d, hdr)), this.index, this.last);
      for (const value of values) {
        if (this.matcher.isCount()) {
          entryCount++;
          continue;
        }
        const r = this.matcher.tryMatch(d, decodeHeaderValue(value), matchOpts(d));
        if (r === true) return true;
        if (r === "unknown") unknown = true;
      }
    }
    if (this.matcher.isCount()) return this.matcher.countMatches(d, entryCount);
    return unknown ? "unknown" : false;
  }
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
