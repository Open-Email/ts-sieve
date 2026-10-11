// RFC 5703 mime and foreverypart: the message's MIME part tree, the parts a
// :mime test examines, and the values its MIMEOPTS select.
//
// The tree is built once per Message from the same splitter the body test uses
// (body.ts), under the same depth and part caps, and with the same reading of
// a body the host's read window cut: every part the prefix does not show comes
// after every part it does, in document order. A part whose children may go on
// past the cut (or past a cap) is `open`; a part is only in the tree once its
// header block is complete, so its headers are definite.

import {
  binaryToBytes,
  bytesToBinary,
  MAX_MIME_DEPTH,
  MAX_MIME_PARTS,
  skipDelimiterLineEnd,
  splitBoundary,
  splitHeaderBody,
} from "./body.js";
import { decodeHeaderValue, getHeader } from "./header.js";
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
}

const trees = new WeakMap<Message, MimePart>();

/** The message's part tree, built on first use and kept per Message. Its
 * structure comes from the raw Content-Type header, as the body test's does. */
export function mimeTree(d: RuntimeData): MimePart {
  let root = trees.get(d.msg);
  if (root !== undefined) return root;
  root = { headers: null, children: [], open: false, openBelow: false };
  const raw = d.msg.bodyRaw();
  if (raw !== null) {
    const cut = d.msg.bodyTruncated?.() ?? false;
    build(root, d.msg.headerGet("content-type")[0] ?? "", bytesToBinary(raw), cut, 0, { parts: 0 });
  }
  trees.set(d.msg, root);
  return root;
}

function build(p: MimePart, contentType: string, b: string, cut: boolean, depth: number, counter: { parts: number }): void {
  const { value: mediaType, params } = parseContentValue(contentType || "text/plain");
  if (mediaType.startsWith("multipart/")) {
    const boundary = params.get("boundary");
    if (!boundary) return;
    if (depth >= MAX_MIME_DEPTH) {
      p.open = true;
    } else {
      const chunks = splitBoundary(b, boundary, cut);
      let sawClose = false;
      const nested: string[] = [];
      for (let i = 1; i < chunks.length; i++) {
        const c = chunks[i]!;
        if (c.startsWith("--")) {
          sawClose = true;
          break;
        }
        nested.push(skipDelimiterLineEnd(c));
      }
      const lastCut = cut && !sawClose;
      if (lastCut) p.open = true;
      for (let i = 0; i < nested.length; i++) {
        if (++counter.parts > MAX_MIME_PARTS) {
          p.open = true;
          break;
        }
        const partCut = lastCut && i === nested.length - 1;
        const { header, body, sep } = splitHeaderBody(nested[i]!);
        if (partCut && !sep) continue; // its header block is cut: not yet a part
        const child: MimePart = { headers: parseHeaderFields(header), children: [], open: false, openBelow: false };
        p.children.push(child);
        build(child, child.headers!.get("content-type")?.[0] ?? "", body, partCut, depth + 1, counter);
      }
    }
  } else if (mediaType === "message/rfc822") {
    const { header, body, sep } = splitHeaderBody(b);
    if (cut && !sep) {
      p.open = true;
    } else if (depth >= MAX_MIME_DEPTH || ++counter.parts > MAX_MIME_PARTS) {
      p.open = true;
    } else {
      const child: MimePart = { headers: parseHeaderFields(header), children: [], open: false, openBelow: false };
      p.children.push(child);
      build(child, child.headers!.get("content-type")?.[0] ?? "", body, cut, depth + 1, counter);
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

/** The part a running foreverypart has reached, or null outside every loop. */
export function currentPart(d: RuntimeData): MimePart | null {
  return d.partStack.length > 0 ? d.partStack[d.partStack.length - 1]! : null;
}

/** p and every part nested in it, depth first: the order foreverypart visits
 * them in (RFC 5703 §3), which is document order. */
export function subtree(p: MimePart): MimePart[] {
  const out: MimePart[] = [];
  const stack = [p];
  while (stack.length > 0) {
    const q = stack.pop()!;
    out.push(q);
    for (let i = q.children.length - 1; i >= 0; i--) stack.push(q.children[i]!);
  }
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
    if (!this.anychild) return { parts: [cur], open: false };
    return { parts: subtree(cur), open: cur.openBelow };
  }

  /** The strings a header test matches for a field's raw values: decoded, or
   * the part of a Content-Type / Content-Disposition the MIMEOPT names. */
  values(name: string, raw: string[], params: string[]): string[] {
    if (this.opt === "") return raw.map(decodeHeaderValue);
    const out: string[] = [];
    const field = name.toLowerCase();
    for (const v of raw) {
      const parsed = parseContentValue(v);
      if (this.opt === "param") {
        for (const want of params) {
          const p = parsed.params.get(want.toLowerCase());
          if (p !== undefined) out.push(decodeHeaderValue(p));
        }
        continue;
      }
      if (parsed.value === "") continue;
      const slash = parsed.value.indexOf("/");
      const type = slash === -1 ? parsed.value : parsed.value.slice(0, slash);
      const sub = slash === -1 ? "" : parsed.value.slice(slash + 1);
      if (field === "content-type") {
        out.push(this.opt === "type" ? type : this.opt === "subtype" ? sub : parsed.value);
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
    const m = /^(.+?)\*(\d+)?(\*)?$/.exec(key);
    if (m === null) {
      if (!out.has(key)) out.set(key, value);
      continue;
    }
    const [, base, index, star] = m;
    if (index === undefined) {
      // "name*": one extended value
      out.set(base!, decodeExtended(value) ?? value);
      continue;
    }
    const list = sections.get(base!) ?? [];
    list.push({ index: Number(index), value, encoded: star === "*" });
    sections.set(base!, list);
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
    if (c === 0x25 /* % */ && i + 2 < s.length && /^[0-9a-fA-F]{2}$/.test(s.slice(i + 1, i + 3))) {
      out.push(Number.parseInt(s.slice(i + 1, i + 3), 16));
      i += 2;
    } else if (c < 0x80) {
      out.push(c);
    } else {
      for (const b of new TextEncoder().encode(s[i]!)) out.push(b);
    }
  }
}

function decodeCharset(bytes: Uint8Array, charset: string): string {
  try {
    return new TextDecoder(charset.trim() || "utf-8").decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}
