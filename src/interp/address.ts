// Address handling — addr-spec split/splitSubaddress, stripRFC2822Comments,
// parseEnvelopeAddress.
//
// Header address lists are parsed by a compact RFC 5322 address-list parser
// covering the common forms (display-name <addr>, bare addr, quoted names, comma
// lists); anything it can't parse falls back (in the caller) to literal matching
// on parse error.

import { SieveError } from "../errors.js";

export const SUBADDRESS_SEPARATOR = "+";

/** Split an addr-spec into local-part + domain. */
export function splitAddress(addr: string): { mailbox: string; domain: string } {
  if (addr.toLowerCase() === "postmaster") return { mailbox: addr, domain: "" };
  const idx = addr.lastIndexOf("@");
  if (idx === -1) throw new SieveError("address: missing at-sign");
  const mailbox = addr.slice(0, idx);
  const domain = addr.slice(idx + 1);
  if (mailbox === "") throw new SieveError("address: empty local-part");
  if (domain === "") throw new SieveError("address: empty domain");
  return { mailbox, domain };
}

/** RFC 5233 local-part → {user, detail} on the first separator. */
export function splitSubaddress(localPart: string): { user: string; detail: string } {
  const idx = localPart.indexOf(SUBADDRESS_SEPARATOR);
  if (idx === -1) return { user: localPart, detail: "" };
  return { user: localPart.slice(0, idx), detail: localPart.slice(idx + SUBADDRESS_SEPARATOR.length) };
}

/** Remove RFC 2822 comments (text in parentheses) and trim. */
export function stripRFC2822Comments(addr: string): string {
  return addr.replace(/\([^)]*\)/g, "").trim();
}

/** Split a header value on top-level commas, honouring quotes and angle brackets. */
function splitAddressList(s: string): string[] {
  const parts: string[] = [];
  let cur = "";
  let inQuote = false;
  let inAngle = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === '"' && !inAngle) {
      inQuote = !inQuote;
      cur += c;
    } else if (c === "<" && !inQuote) {
      inAngle = true;
      cur += c;
    } else if (c === ">" && !inQuote) {
      inAngle = false;
      cur += c;
    } else if (c === "," && !inQuote && !inAngle) {
      parts.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  parts.push(cur);
  return parts;
}

/**
 * Parse an address-list header value into addr-specs. Throws if a non-empty
 * entry yields no address (caller then falls back to literal matching on parse
 * error).
 */
export function parseAddressList(value: string): { address: string }[] {
  const out: { address: string }[] = [];
  for (const raw of splitAddressList(value)) {
    const p = raw.trim();
    if (p === "") continue;
    const lt = p.indexOf("<");
    const gt = p.lastIndexOf(">");
    let addr: string;
    if (lt !== -1 && gt !== -1 && gt > lt) {
      addr = p.slice(lt + 1, gt).trim();
    } else {
      addr = p;
    }
    if (addr === "") throw new SieveError("address: empty address in list");
    out.push({ address: addr });
  }
  return out;
}

function count(s: string, sub: string): number {
  let n = 0;
  let i = s.indexOf(sub);
  while (i !== -1) {
    n++;
    i = s.indexOf(sub, i + sub.length);
  }
  return n;
}

/**
 * An RFC 5321 envelope-address validator. Returns the cleaned address ("" for
 * the null reverse path `<>`); throws on invalid syntax so callers can keep the
 * raw value (test_set) or skip the value (envelope test). Handles source routes
 * (`<@host1,@host2:user@domain>` → `user@domain`), bare/bracketed addr-specs, and
 * the MAILER-DAEMON special case.
 */
export function parseEnvelopeAddress(addr: string): string {
  if (addr === "") return "";
  if (addr === "<>") return "";

  // Not in angle brackets: validate the basic bare-address syntax.
  if (!addr.startsWith("<") || !addr.endsWith(">")) {
    if (!addr.includes("@") && addr !== "MAILER-DAEMON") {
      throw new SieveError(`invalid envelope address syntax: ${addr}`);
    }
    if (addr.endsWith("@") && addr !== "MAILER-DAEMON@") {
      throw new SieveError("invalid envelope address syntax: missing domain");
    }
    if (addr.startsWith("@")) {
      throw new SieveError("invalid envelope address syntax: missing local part");
    }
    return addr;
  }

  const inner = addr.slice(1, -1);

  // Source route: <@host1,@host2:user@domain>
  const colon = inner.indexOf(":");
  if (colon !== -1) {
    const sourceRoute = inner.slice(0, colon);
    const actualAddr = inner.slice(colon + 1);
    if (!sourceRoute.startsWith("@")) throw new SieveError("invalid source route: must start with @");
    // Invalid: @host1@host2  Valid: @host1,@host2
    if (count(sourceRoute, "@") > count(sourceRoute, ",") + 1) {
      throw new SieveError("invalid source route: malformed host list");
    }
    for (const raw of sourceRoute.split(",")) {
      const host = raw.trim();
      if (!host.startsWith("@") || host.length < 2) throw new SieveError(`invalid source route host: ${host}`);
      if (count(host, "@") !== 1) throw new SieveError(`invalid source route host format: ${host}`);
      const hostName = host.slice(1);
      if (hostName === "" || hostName.includes("..") || hostName.startsWith(".") || hostName.endsWith(".")) {
        throw new SieveError(`invalid hostname in source route: ${hostName}`);
      }
    }
    return actualAddr;
  }

  if (inner === "MAILER-DAEMON") return inner;

  const ats = count(inner, "@");
  if (ats !== 1) {
    if (ats === 0) throw new SieveError("invalid envelope address: missing @");
    throw new SieveError("invalid envelope address: multiple @");
  }
  const ai = inner.indexOf("@");
  if (inner.slice(0, ai) === "" || inner.slice(ai + 1) === "") {
    throw new SieveError("invalid envelope address: empty local part or domain");
  }
  return inner;
}
