// RFC 5703 mime and foreverypart: the message's MIME part tree, the parts a
// :mime test examines, and the values its MIMEOPTS select.
//
// The tree is built once per Message from the same splitter the body test uses
// (body.ts), under the same depth and part caps, and with the same reading of
// a body the host's read window cut: every part the prefix does not show comes
// after every part it does, in document order. A part whose children may go on
// past the cut (or past a cap) is `open`; a part is only in the tree once its
// header block is complete, so its headers are definite. Past the depth cap,
// and where a part's list turns on core's buffering (see InputEnd in body.ts),
// an open part can have parts after it: foreverypart discloses an iteration
// past one.

import {
  binaryToBytes,
  charsetDecode,
  cteDecode,
  MAX_MIME_DEPTH,
  MAX_MIME_PARTS,
  isMessage,
  parseMediaType,
  parseMimeHeader,
  rawBinary,
  readHeaderBlock,
  splitMultipart,
  type InputEnd,
} from "./body.js";
import { decodeHeaderValue, getHeader } from "./header.js";
import { rootHeaderBytes } from "./mediatype.js";
import { htmlToText } from "./htmltext.js";
import type { Message, RuntimeData } from "./runtime.js";
import type { SpecTag } from "./spec.js";

export interface MimePart {
  /** null for the message itself: its header is read through the Message, so
   * header edits apply. */
  headers: Map<string, string[]> | null;
  children: MimePart[];
  /** More children may follow those in the tree: the multipart runs past the
   * read-window cut, or the caps stopped the walk. */
  open: boolean;
  /** This part or a part nested in it is open. */
  openBelow: boolean;
  /** subtree(), computed once. */
  all: MimePart[] | null;
  /** The part's body, still transfer-encoded, as a binary string. */
  body: string;
  /** The body is a prefix: the read-window cut fell in it, or (the root
   * only) the host did not read it at all. */
  cut: boolean;
  /** A multipart or a nested message: its content is its parts. */
  container: boolean;
  /** extracttext's reading of it, for one decode limit. */
  text: { limit: number; text: string; complete: boolean } | null;
  /** The Content-Type and Content-Transfer-Encoding its content is read by:
   * the fields the body test reads (the first of each, at the top as in a
   * part), not header edits. */
  contentType: string;
  cte: string;
}

function newPart(headers: Map<string, string[]> | null, body: string, cut: boolean, contentType = "", cte = ""): MimePart {
  return {
    headers,
    children: [],
    open: false,
    openBelow: false,
    all: null,
    body,
    cut,
    container: false,
    text: null,
    contentType,
    cte,
  };
}

const trees = new WeakMap<Message, MimePart>();

/** The message's part tree, built on first use and kept per Message. Its
 * structure is read exactly as the body test reads it (the same Content-Type
 * field, the same boundary parameter, the same splitter), so a :mime test and
 * a body test never disagree about which parts there are. */
export function mimeTree(d: RuntimeData): MimePart {
  let root = trees.get(d.msg);
  if (root !== undefined) return root;
  const contentType = rootHeaderBytes(d.msg, "content-type");
  const cte = rootHeaderBytes(d.msg, "content-transfer-encoding");
  const raw = d.msg.bodyRaw();
  if (raw !== null) {
    const cut = d.msg.bodyTruncated?.() ?? false;
    root = newPart(null, rawBinary(d.msg, raw), cut, contentType, cte);
    build(root, contentType, root.body, cut, "whole", 0, { parts: 0 });
  } else {
    // A body the host did not read: whatever it holds was not seen.
    root = newPart(null, "", true, contentType, cte);
    root.container = holdsParts(contentType);
    if (root.container) root.open = root.openBelow = true;
  }
  trees.set(d.msg, root);
  return root;
}

/** Whether a part of this type has parts of its own: a multipart (with no
 * boundary, or no part found, it has the child core synthesizes), or a nested
 * message. */
function holdsParts(contentType: string): boolean {
  const { mediaType, primary } = parseMediaType(contentType || "text/plain");
  return primary === "multipart" || isMessage(mediaType);
}

/** `inputEnd`: see InputEnd in body.ts. */
function build(p: MimePart, contentType: string, b: string, cut: boolean, inputEnd: InputEnd, depth: number, counter: { parts: number }): void {
  const { mediaType, primary, params } = parseMediaType(contentType || "text/plain");
  p.container = holdsParts(contentType);
  if (primary === "multipart") {
    if (depth >= MAX_MIME_DEPTH) {
      p.open = true;
    } else {
      const mp = splitMultipart(b, params["boundary"] ?? "", cut, inputEnd);
      if (mp.open) p.open = true;
      for (const part of mp.parts) {
        if (++counter.parts > MAX_MIME_PARTS) {
          p.open = true;
          break;
        }
        const child = newPart(parseHeaderFields(part.fields), part.body, part.cut, part.contentType, part.cte);
        p.children.push(child);
        build(child, child.contentType, part.body, part.cut, part.ends, depth + 1, counter);
      }
    }
  } else if (isMessage(mediaType)) {
    const h = readHeaderBlock(b, 0, Infinity, cut);
    if (h.open) {
      p.open = true;
    } else if (depth >= MAX_MIME_DEPTH || ++counter.parts > MAX_MIME_PARTS) {
      p.open = true;
    } else {
      const fields = parseMimeHeader(h.fields);
      const body = b.slice(h.end);
      const child = newPart(parseHeaderFields(h.fields), body, cut, fields.get("content-type") ?? "", fields.get("content-transfer-encoding") ?? "");
      p.children.push(child);
      build(child, child.contentType, body, cut, "whole", depth + 1, counter);
    }
  }
  p.openBelow = p.open || p.children.some((c) => c.openBelow);
}

/** A part's header fields: names lower-cased, values in order, unfolded, the
 * octets read as UTF-8 (RFC 6532). */
function parseHeaderFields(block: string): Map<string, string[]> {
  const text = new TextDecoder().decode(binaryToBytes(block));
  const fields = new Map<string, string[]>();
  let name = "";
  let value = "";
  const flush = () => {
    if (name === "") return;
    const list = fields.get(name);
    if (list) list.push(value);
    else fields.set(name, [value]);
    name = "";
  };
  for (const line of text.split(/\r?\n/)) {
    if (line.length > 0 && (line.charCodeAt(0) === 32 || line.charCodeAt(0) === 9)) {
      if (name !== "") value += line;
      continue;
    }
    flush();
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    name = line.slice(0, colon).trim().toLowerCase();
    value = line.slice(colon + 1).replace(/^[ \t]+/, "");
  }
  flush();
  return fields;
}

/**
 * A part's text as extracttext stores it (RFC 5703 §7): the transfer encoding
 * removed, text transcoded to UTF-8, HTML reduced to its text, at most `limit`
 * octets of decoded content. A part holding parts, or a text part in a charset
 * this runtime cannot decode, yields "" (§7: "an empty string will result"); a
 * non-text leaf is decoded as UTF-8, as Pigeonhole and go-sieve do.
 * `complete`: nothing was left out, neither by the read-window cut (the text
 * of a cut part is a prefix of the real one, see body.ts) nor by the limit.
 * Decoded once per part, charged by size.
 */
export function partText(d: RuntimeData, p: MimePart, limit: number): { text: string; complete: boolean } {
  if (p.text !== null && p.text.limit === limit) return p.text;
  let text = "";
  let complete = true;
  if (!p.container) {
    d.budget.consume(1 + (p.body.length >> 10));
    const { mediaType, params } = parseMediaType(p.contentType || "text/plain; charset=us-ascii");
    const charset = params["charset"] ?? "us-ascii";
    let bytes = cteDecode(binaryToBytes(p.body), p.cte, p.cut);
    // An encoding or charset that cannot be decoded gives "" however much of
    // the part was read: nothing is missing from that answer.
    if (bytes !== null && (!mediaType.startsWith("text/") || charsetKnown(charset))) {
      complete = !p.cut;
      if (bytes.length > limit) {
        bytes = bytes.subarray(0, limit);
        complete = false;
      }
      const prefix = !complete;
      text = mediaType.startsWith("text/")
        ? charsetDecode(bytes, charset, prefix)
        : new TextDecoder().decode(bytes, { stream: prefix });
      if (mediaType === "text/html" || mediaType === "application/xhtml+xml") text = htmlToText(text, prefix);
    }
  }
  p.text = { limit, text, complete };
  return p.text;
}

function charsetKnown(charset: string): boolean {
  const cs = charset.toLowerCase().trim();
  // The labels charsetDecode handles itself, then whatever TextDecoder knows.
  if (cs === "" || cs === "us-ascii" || cs === "ascii" || cs === "iso-8859-1" || cs === "latin1" || cs === "iso8859-1") return true;
  if (cs === "utf-16" || cs === "utf16" || cs === "utf8") return true;
  try {
    new TextDecoder(cs);
    return true;
  } catch {
    return false;
  }
}

/** The part a running foreverypart has reached, or null outside every loop. */
export function currentPart(d: RuntimeData): MimePart | null {
  return d.partStack.length > 0 ? d.partStack[d.partStack.length - 1]! : null;
}

/** p and every part nested in it, depth first: the order foreverypart visits
 * them in (RFC 5703 §3), which is document order. */
export function subtree(p: MimePart): MimePart[] {
  if (p.all !== null) return p.all;
  const out: MimePart[] = [];
  const stack = [p];
  while (stack.length > 0) {
    const q = stack.pop()!;
    out.push(q);
    for (let i = q.children.length - 1; i >= 0; i--) stack.push(q.children[i]!);
  }
  p.all = out;
  return out;
}

/** A part's values of a header field, raw. */
export function partHeader(d: RuntimeData, p: MimePart, name: string): string[] {
  return p.headers === null ? getHeader(d, name) : (p.headers.get(name.toLowerCase()) ?? []);
}

export type MimeOpt = "" | "type" | "subtype" | "contenttype" | "param";

/** The :mime, :anychild and MIMEOPTS tagged arguments RFC 5703 adds to the
 * header, address and exists tests. */
export class MimeOpts {
  enabled = false;
  anychild = false;
  opt: MimeOpt = "";
  private optCount = 0;
  params: string[] = [];

  /** Register the tags; MIMEOPTS exist on the header test only. */
  addSpecTags(tags: Record<string, SpecTag>, withOpts: boolean): void {
    tags["mime"] = { matchBool: () => (this.enabled = true) };
    tags["anychild"] = { matchBool: () => (this.anychild = true) };
    if (!withOpts) return;
    const choose = (opt: MimeOpt) => {
      this.opt = opt;
      this.optCount++;
    };
    tags["type"] = { matchBool: () => choose("type") };
    tags["subtype"] = { matchBool: () => choose("subtype") };
    tags["contenttype"] = { matchBool: () => choose("contenttype") };
    tags["param"] = {
      needsValue: true,
      minStrCount: 1,
      matchStr: (val) => {
        choose("param");
        this.params = val;
      },
    };
  }

  /** Why the tags as given are refused, or null. */
  invalid(requiresMime: boolean): string | null {
    if (this.optCount > 1) return "only one of :type, :subtype, :contenttype or :param is allowed";
    if ((this.anychild || this.optCount > 0) && !this.enabled) {
      return ":anychild, :type, :subtype, :contenttype and :param require :mime";
    }
    if (this.enabled && !requiresMime) return "missing require 'mime'";
    return null;
  }

  /** The parts the test examines (RFC 5703 §4.1): the running loop's part, or
   * the message outside every loop, and with :anychild every part nested in
   * it. `open`: parts in scope may lie past the cut, so a miss is unknown. */
  scope(d: RuntimeData): { parts: MimePart[]; open: boolean } {
    const cur = currentPart(d) ?? mimeTree(d);
    const parts = this.anychild ? subtree(cur) : [cur];
    // Each part examined costs a step: inside loops, the parts a test visits
    // multiply with the iterations.
    d.budget.consume(parts.length);
    return { parts, open: this.anychild && cur.openBelow };
  }

  /**
   * Whether the test reads only the first of a part's `name` fields: under a
   * MIMEOPT, Content-Type and Content-Disposition. A part has one media type
   * and one disposition, its first field's: core's walker reads them so
   * (go-message's Header.Get), and the client shows that one; the part tree
   * and the body test read the first Content-Type too (parseMimeHeader).
   * Reading every field, as Pigeonhole does, matched a second type the
   * client never shows (#72).
   * The root's first is the header's as the script's edits left it (RFC 5293:
   * a test reads the edited header), while the tree and the body test read
   * the message's structure as received: with no edit to the field, the same
   * field. Plain :mime reads every field, as the header test does.
   */
  firstOnly(name: string): boolean {
    if (this.opt === "") return false;
    const field = name.toLowerCase();
    return field === "content-type" || field === "content-disposition";
  }

  /** The strings a header test matches for a field's raw values: decoded, or
   * the part of a Content-Type / Content-Disposition the MIMEOPT names. Each
   * value is decoded or parsed once per message and costs a step per read,
   * plus its size the first time. */
  values(d: RuntimeData, name: string, raw: string[], params: string[]): string[] {
    const derive = <T,>(v: string, kind: string, f: (v: string) => T): T => {
      d.budget.consume(1);
      const cache = derivedCache(d.msg, kind);
      let r = cache.get(v) as T | undefined;
      if (r === undefined) {
        d.budget.consume(v.length >> 6);
        r = f(v);
        cache.set(v, r);
      }
      return r;
    };
    if (this.opt === "") return raw.map((v) => derive(v, "d", decodeHeaderValue));
    const out: string[] = [];
    const field = name.toLowerCase();
    for (const v of raw) {
      if (this.opt === "param") {
        const parsed = derive(v, "p", parseContentValue);
        for (const want of params) {
          const p = parsed.params.get(want.toLowerCase());
          if (p !== undefined) out.push(derive(p, "d", decodeHeaderValue));
        }
        continue;
      }
      // No parameter needed: only the text before the first ";".
      const value = derive(v, "v", contentValueOnly);
      if (value === "") continue;
      const slash = value.indexOf("/");
      const type = slash === -1 ? value : value.slice(0, slash);
      const sub = slash === -1 ? "" : value.slice(slash + 1);
      if (field === "content-type") {
        out.push(this.opt === "type" ? type : this.opt === "subtype" ? sub : value);
      } else if (field === "content-disposition") {
        // A disposition has no subtype; :contenttype is the disposition itself.
        out.push(this.opt === "subtype" ? "" : type);
      } else {
        out.push("");
      }
    }
    return out;
  }
}

/** Per message and kind: header values decoded or parsed for :mime tests,
 * keyed by the raw value itself (header edits can change the root's values,
 * and a string's hash is computed once, however long it is). */
const derivedCaches = new WeakMap<Message, Map<string, Map<string, unknown>>>();

function derivedCache(msg: Message, kind: string): Map<string, unknown> {
  let byKind = derivedCaches.get(msg);
  if (byKind === undefined) derivedCaches.set(msg, (byKind = new Map()));
  let m = byKind.get(kind);
  if (m === undefined) byKind.set(kind, (m = new Map()));
  return m;
}

/** The media type or disposition of a value, lower-cased, without parsing its
 * parameters. */
function contentValueOnly(v: string): string {
  const semi = indexOutsideQuotes(v, 0);
  return (semi === -1 ? v : v.slice(0, semi)).trim().toLowerCase();
}

/**
 * A Content-Type or Content-Disposition value: the media type or disposition
 * lower-cased, and its parameters (names lower-cased) with RFC 2231
 * continuations joined and extended values decoded. Lenient, as mail is: a
 * parameter that does not parse is skipped, not the whole value.
 */
export function parseContentValue(v: string): { value: string; params: Map<string, string> } {
  const semi = indexOutsideQuotes(v, 0);
  const value = (semi === -1 ? v : v.slice(0, semi)).trim().toLowerCase();
  const raw = new Map<string, string>();
  // One pass: each ";"-separated segment is scanned once.
  for (let i = semi === -1 ? v.length : semi + 1; i < v.length; ) {
    const end = indexOutsideQuotes(v, i);
    const seg = v.slice(i, end === -1 ? v.length : end);
    i = end === -1 ? v.length : end + 1;
    const eq = seg.indexOf("=");
    if (eq === -1) continue; // not a parameter
    const key = seg.slice(0, eq).trim().toLowerCase();
    const val = unquote(seg.slice(eq + 1).trim());
    if (key !== "" && !raw.has(key)) raw.set(key, val);
  }
  return { value, params: joinRfc2231(raw) };
}

/** A parameter value: a quoted-string's content (backslash escapes undone,
 * up to its closing quote), or the token as is. */
function unquote(v: string): string {
  if (!v.startsWith('"')) return v;
  let out = "";
  for (let i = 1; i < v.length; i++) {
    const c = v[i]!;
    if (c === '"') break;
    if (c === "\\" && i + 1 < v.length) i++;
    out += v[i];
  }
  return out;
}

/** The next ";" at or after `from` outside a quoted string, or -1. */
function indexOutsideQuotes(v: string, from: number): number {
  let quoted = false;
  for (let i = from; i < v.length; i++) {
    const c = v[i];
    if (quoted) {
      if (c === "\\") i++;
      else if (c === '"') quoted = false;
    } else if (c === '"') {
      quoted = true;
    } else if (c === ";") {
      return i;
    }
  }
  return -1;
}

/** RFC 2231: "name*=charset'lang'%XX…" is an extended value; "name*0", "name*1*"
 * … are continuations, joined in order (the "*" ones percent-encoded, the first
 * carrying the charset). A plain "name" is used when neither is present. */
function joinRfc2231(raw: Map<string, string>): Map<string, string> {
  const out = new Map<string, string>();
  const sections = new Map<string, { index: number; value: string; encoded: boolean }[]>();
  for (const [key, value] of raw) {
    const k = sectionKey(key);
    if (k === null) {
      if (!out.has(key)) out.set(key, value);
      continue;
    }
    if (k.index === null) {
      // "name*": one extended value
      out.set(k.base, decodeExtended(value) ?? value);
      continue;
    }
    const list = sections.get(k.base) ?? [];
    list.push({ index: k.index, value, encoded: k.star });
    sections.set(k.base, list);
  }
  for (const [base, list] of sections) {
    if (raw.has(`${base}*`)) continue;
    list.sort((a, b) => a.index - b.index);
    let charset = "";
    const bytes: number[] = [];
    for (let k = 0; k < list.length && list[k]!.index === k; k++) {
      const s = list[k]!;
      let text = s.value;
      if (s.encoded && k === 0) {
        const q1 = text.indexOf("'");
        const q2 = q1 === -1 ? -1 : text.indexOf("'", q1 + 1);
        if (q2 !== -1) {
          charset = text.slice(0, q1);
          text = text.slice(q2 + 1);
        }
      }
      if (s.encoded) pushPercentDecoded(bytes, text);
      else for (const b of new TextEncoder().encode(text)) bytes.push(b);
    }
    out.set(base, decodeCharset(Uint8Array.from(bytes), charset));
  }
  return out;
}

/** An RFC 2231 parameter name: "base*" (extended), "base*N" or "base*N*"
 * (a section); null for a plain name. Scanned from the end, no regex. */
function sectionKey(key: string): { base: string; index: number | null; star: boolean } | null {
  let end = key.length;
  const star = key.endsWith("*");
  if (star) end--;
  let j = end;
  while (j > 0 && key.charCodeAt(j - 1) >= 0x30 && key.charCodeAt(j - 1) <= 0x39) j--;
  if (j < end && j > 1 && key[j - 1] === "*") return { base: key.slice(0, j - 1), index: Number(key.slice(j, end)), star };
  if (star && end > 0) return { base: key.slice(0, end), index: null, star: true };
  return null;
}

function decodeExtended(value: string): string | null {
  const q1 = value.indexOf("'");
  const q2 = q1 === -1 ? -1 : value.indexOf("'", q1 + 1);
  if (q2 === -1) return null;
  const bytes: number[] = [];
  pushPercentDecoded(bytes, value.slice(q2 + 1));
  return decodeCharset(Uint8Array.from(bytes), value.slice(0, q1));
}

function pushPercentDecoded(out: number[], s: string): void {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const hi = c === 0x25 /* % */ && i + 2 < s.length ? hexDigit(s.charCodeAt(i + 1)) : -1;
    const lo = hi === -1 ? -1 : hexDigit(s.charCodeAt(i + 2));
    if (lo !== -1) {
      out.push(hi * 16 + lo);
      i += 2;
    } else if (c < 0x80) {
      out.push(c);
    } else {
      for (const b of new TextEncoder().encode(s[i]!)) out.push(b);
    }
  }
}

function hexDigit(c: number): number {
  if (c >= 0x30 && c <= 0x39) return c - 0x30;
  if (c >= 0x41 && c <= 0x46) return c - 0x37;
  if (c >= 0x61 && c <= 0x66) return c - 0x57;
  return -1;
}

function decodeCharset(bytes: Uint8Array, charset: string): string {
  try {
    return new TextDecoder(charset.trim() || "utf-8").decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}
