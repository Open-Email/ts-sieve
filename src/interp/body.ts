// RFC 5173 body test.
//
// Uses a hand-rolled BYTE-level MIME walker (not a general parser), so it walks
// the body as a "binary string" (one char per byte, 0–255) to keep indexOf/slice
// offsets byte-exact. Leaf text parts are transfer-decoded (QP/base64) then
// charset-decoded to UTF-8; :text HTML parts are stripped to text. Everything is
// linear/bounded (no backtracking regex on body content).

import { MatcherTest } from "./matcher.js";
import type { RuntimeData, Test } from "./runtime.js";

// -------- byte/binary-string helpers --------

function bytesToBinary(u8: Uint8Array): string {
  let s = "";
  for (let i = 0; i < u8.length; i += 0x8000) {
    s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  }
  return s;
}
function binaryToBytes(s: string): Uint8Array {
  const u8 = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i) & 0xff;
  return u8;
}

// -------- transfer-encoding decode --------

function qpDecode(bytes: Uint8Array): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!;
    if (b === 0x3d /* = */) {
      const h1 = bytes[i + 1];
      const h2 = bytes[i + 2];
      if (h1 === 0x0d && h2 === 0x0a) {
        i += 2; // soft break =\r\n
      } else if (h1 === 0x0a) {
        i += 1; // soft break =\n
      } else if (h1 !== undefined && h2 !== undefined) {
        const v = Number.parseInt(String.fromCharCode(h1, h2), 16);
        if (!Number.isNaN(v)) {
          out.push(v);
          i += 2;
        } else {
          out.push(b);
        }
      } else {
        out.push(b);
      }
    } else {
      out.push(b);
    }
  }
  return Uint8Array.from(out);
}

function base64Decode(bytes: Uint8Array): Uint8Array {
  const clean = bytesToBinary(bytes).replace(/[^A-Za-z0-9+/=]/g, "");
  const bin = atob(clean);
  return binaryToBytes(bin);
}

/** Returns transfer-decoded bytes, or null on an unknown encoding (skip part). */
function cteDecode(bytes: Uint8Array, cte: string): Uint8Array | null {
  const e = cte.toLowerCase().trim();
  if (e === "" || e === "7bit" || e === "8bit" || e === "binary") return bytes;
  if (e === "base64") return base64Decode(bytes);
  if (e === "quoted-printable") return qpDecode(bytes);
  return null;
}

// -------- charset decode --------

function charsetDecode(bytes: Uint8Array, charset: string): string {
  const cs = charset.toLowerCase().trim();
  if (cs === "" || cs === "utf-8" || cs === "utf8" || cs === "us-ascii" || cs === "ascii") {
    return new TextDecoder("utf-8").decode(bytes);
  }
  if (cs === "iso-8859-1" || cs === "latin1" || cs === "iso8859-1") {
    // True Latin-1 (byte → code point). TextDecoder maps this label to cp1252.
    let s = "";
    for (const b of bytes) s += String.fromCharCode(b);
    return s;
  }
  try {
    return new TextDecoder(cs, { fatal: false }).decode(bytes);
  } catch {
    return bytesToBinary(bytes); // unknown charset ⇒ keep raw (tolerate unknown charsets)
  }
}

// -------- HTML → text --------

const ENTITIES: Record<string, string> = {
  nbsp: " ",
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  auml: "ä",
  ouml: "ö",
  uuml: "ü",
  Auml: "Ä",
  Ouml: "Ö",
  Uuml: "Ü",
  szlig: "ß",
  eacute: "é",
  egrave: "è",
  agrave: "à",
  ccedil: "ç",
  copy: "©",
  reg: "®",
  trade: "™",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  bull: "•",
};

function unescapeHtml(s: string): string {
  return s.replace(/&(#[xX][0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);/g, (m, ent: string) => {
    if (ent[0] === "#") {
      const cp = ent[1] === "x" || ent[1] === "X" ? Number.parseInt(ent.slice(2), 16) : Number.parseInt(ent.slice(1), 10);
      if (Number.isFinite(cp) && cp >= 0 && cp <= 0x10ffff) {
        try {
          return String.fromCodePoint(cp);
        } catch {
          return m;
        }
      }
      return m;
    }
    return ENTITIES[ent] ?? m;
  });
}

function htmlToText(s: string): string {
  let x = s.replace(/<[^>]*>/g, " "); // linear: [^>]* and required > don't backtrack badly
  x = unescapeHtml(x);
  x = x.replace(/[\t\n\f\r \p{Zs}]+/gu, " ");
  return x.trim();
}

// -------- media type + header parsing --------

function parseMediaType(ct: string): { mediaType: string; params: Record<string, string> } {
  const semi = ct.indexOf(";");
  const mediaType = (semi === -1 ? ct : ct.slice(0, semi)).trim().toLowerCase();
  const params: Record<string, string> = {};
  if (semi !== -1) {
    for (const part of ct.slice(semi + 1).split(";")) {
      const eq = part.indexOf("=");
      if (eq === -1) continue;
      const k = part.slice(0, eq).trim().toLowerCase();
      let v = part.slice(eq + 1).trim();
      if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) v = v.slice(1, -1);
      params[k] = v;
    }
  }
  return { mediaType, params };
}

/** Parse a MIME header block (binary string) into a case-insensitive last-value map. */
function parseMimeHeader(block: string): Map<string, string> {
  const h = new Map<string, string>();
  const lines = block.split(/\r?\n/);
  let cur = "";
  const flush = (line: string) => {
    const idx = line.indexOf(":");
    if (idx !== -1) h.set(line.slice(0, idx).trim().toLowerCase(), line.slice(idx + 1).trim());
  };
  for (const line of lines) {
    if (/^[ \t]/.test(line) && cur) {
      cur += ` ${line.trim()}`;
    } else {
      if (cur) flush(cur);
      cur = line;
    }
  }
  if (cur) flush(cur);
  return h;
}

function splitHeaderBody(b: string): { header: string; body: string } {
  let idx = b.indexOf("\r\n\r\n");
  if (idx !== -1) return { header: b.slice(0, idx), body: b.slice(idx + 4) };
  idx = b.indexOf("\n\n");
  if (idx !== -1) return { header: b.slice(0, idx), body: b.slice(idx + 2) };
  return { header: b, body: "" };
}

// -------- the body test --------

export class TestBody implements Test {
  readonly matcher = new MatcherTest();
  raw = false;
  text = false;
  content: string[] = [];

  private matchOpts(d: RuntimeData) {
    return { maxMatchInputLength: d.script.opts.maxMatchInputLength };
  }

  check(d: RuntimeData): boolean {
    const savedVars = d.matchVariables;
    try {
      const raw = d.msg.bodyRaw();
      if (raw === null) return false;

      if (this.raw) {
        if (this.matcher.isCount()) return this.matcher.countMatches(d, 1);
        return this.matcher.tryMatch(d, bytesToBinary(raw), this.matchOpts(d));
      }

      const topCt = d.msg.headerGet("content-type")[0] ?? "text/plain; charset=us-ascii";
      const topCte = d.msg.headerGet("content-transfer-encoding")[0] ?? "";
      const counter = { count: 0 };
      const matched = this.walk(d, topCt, topCte, bytesToBinary(raw), counter);
      if (matched) return true;
      if (this.matcher.isCount()) return this.matcher.countMatches(d, counter.count);
      return false;
    } finally {
      d.matchVariables = savedVars; // body restores match vars regardless of outcome
    }
  }

  private wantsPart(mediaType: string): boolean {
    if (this.text) {
      return mediaType.split("/").length === 2 && (mediaType.startsWith("text/") || mediaType === "application/xhtml+xml");
    }
    for (const raw of this.content) {
      const ct = raw.toLowerCase().trim();
      if (ct === "") return true;
      if (ct.startsWith("/") || ct.endsWith("/") || (ct.match(/\//g) ?? []).length > 1) continue;
      if (ct === mediaType || mediaType.startsWith(`${ct}/`)) return true;
    }
    return false;
  }

  private matchOrCount(d: RuntimeData, source: string, counter: { count: number }): boolean {
    if (this.matcher.isCount()) {
      counter.count++;
      return false;
    }
    return this.matcher.tryMatch(d, source, this.matchOpts(d));
  }

  private walk(d: RuntimeData, ctHeader: string, cteHeader: string, b: string, counter: { count: number }): boolean {
    d.budget.consume(1);
    const { mediaType, params } = parseMediaType(ctHeader || "text/plain; charset=us-ascii");
    const process = this.wantsPart(mediaType);

    if (mediaType.startsWith("multipart/")) {
      const boundary = params["boundary"];
      if (!boundary) {
        return process ? this.matchOrCount(d, b, counter) : false;
      }
      const parts = splitBoundary(b, boundary);
      // parts[0] = prologue; find closing --boundary-- marker → epilogue; rest = nested
      let epilogue = "";
      const nested: string[] = [];
      for (let i = 1; i < parts.length; i++) {
        let p = parts[i]!;
        if (p.startsWith("--")) {
          epilogue = p.slice(2);
          if (epilogue.startsWith("\r\n")) epilogue = epilogue.slice(2);
          else if (epilogue.startsWith("\n")) epilogue = epilogue.slice(1);
          break;
        }
        if (p.startsWith("\r\n")) p = p.slice(2);
        else if (p.startsWith("\n")) p = p.slice(1);
        nested.push(p);
      }
      if (process) {
        if (this.matcher.isCount()) {
          counter.count += 2;
        } else {
          if (this.matcher.tryMatch(d, parts[0] ?? "", this.matchOpts(d))) return true;
          if (this.matcher.tryMatch(d, epilogue, this.matchOpts(d))) return true;
        }
      }
      for (const p of nested) {
        const { header, body } = splitHeaderBody(p);
        const h = parseMimeHeader(header);
        if (this.walk(d, h.get("content-type") ?? "", h.get("content-transfer-encoding") ?? "", body, counter)) {
          return true;
        }
      }
      return false;
    }

    if (mediaType === "message/rfc822") {
      const { header, body } = splitHeaderBody(b);
      const hdrBytes = header + (b.includes("\r\n\r\n") ? "\r\n" : "");
      if (process && this.matchOrCount(d, hdrBytes, counter)) return true;
      const h = parseMimeHeader(header);
      return this.walk(d, h.get("content-type") ?? "", h.get("content-transfer-encoding") ?? "", body, counter);
    }

    // leaf
    if (!process) return false;
    const decoded = cteDecode(binaryToBytes(b), cteHeader);
    if (decoded === null) return false; // unknown transfer-encoding → skip
    let text: string;
    if (mediaType.startsWith("text/")) {
      text = charsetDecode(decoded, params["charset"] ?? "us-ascii");
    } else {
      text = bytesToBinary(decoded); // non-text leaf: raw transfer-decoded octets
    }
    if (this.text && (mediaType === "text/html" || mediaType === "application/xhtml+xml")) {
      text = htmlToText(text);
    }
    return this.matchOrCount(d, text, counter);
  }
}

function splitBoundary(b: string, boundary: string): string[] {
  const dash = `\n--${boundary}`;
  const dash2 = `\r\n--${boundary}`;
  const parts: string[] = [];
  let current = b;
  if (current.startsWith(`--${boundary}`)) {
    parts.push("");
    current = current.slice(boundary.length + 2);
  }
  for (;;) {
    let idx = current.indexOf(dash2);
    if (idx === -1) {
      idx = current.indexOf(dash);
      if (idx === -1) {
        parts.push(current);
        break;
      }
      parts.push(current.slice(0, idx));
      current = current.slice(idx + dash.length);
    } else {
      parts.push(current.slice(0, idx));
      current = current.slice(idx + dash2.length);
    }
  }
  return parts;
}
