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
import { getHeader } from "./header.js";
import { decodeHeaderOnce } from "./header-values.js";
import { contentParams, rootHeaderBytes } from "./mediatype.js";
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
    if (this.opt === "") return raw.map((v) => derive(v, "d", (value) => decodeHeaderOnce(d, value)));
    const out: string[] = [];
    const field = name.toLowerCase();
    for (const v of raw) {
      if (this.opt === "param") {
        const parsed = derive(v, "p", contentParams);
        for (const want of params) {
          const p = parsed.get(want.toLowerCase());
          if (p !== undefined) {
            d.budget.consume(1);
            out.push(p); // already decoded once by Core's parameter parser
          }
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
