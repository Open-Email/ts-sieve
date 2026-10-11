// RFC 5173 body test.
//
// Uses a hand-rolled BYTE-level MIME walker (not a general parser), so it walks
// the body as a "binary string" (one char per byte, 0–255) to keep indexOf/slice
// offsets byte-exact. Leaf text parts are transfer-decoded (QP/base64) then
// charset-decoded to UTF-8; :text HTML parts are stripped to text. Everything is
// linear/bounded (no backtracking regex on body content).

import { htmlToText } from "./htmltext.js";
import { MatcherTest } from "./matcher.js";
import type { Message, RuntimeData, Test, Tri } from "./runtime.js";

// -------- byte/binary-string helpers --------

export function bytesToBinary(u8: Uint8Array): string {
  let s = "";
  for (let i = 0; i < u8.length; i += 0x8000) {
    s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  }
  return s;
}
export function binaryToBytes(s: string): Uint8Array {
  const u8 = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i) & 0xff;
  return u8;
}

// -------- transfer-encoding decode --------

/** `cut`: the bytes are a prefix of the encoded part, so an escape (or soft
 * break) the cut split is dropped: its meaning lies past the cut, and kept as
 * text it would be content the part does not have. */
function qpDecode(bytes: Uint8Array, cut: boolean): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!;
    if (b === 0x3d /* = */) {
      if (cut && i + 2 >= bytes.length) break;
      const h1 = bytes[i + 1];
      const h2 = bytes[i + 2];
      if (h1 === 0x0d && h2 === 0x0a) {
        i += 2; // soft break =\r\n
      } else if (h1 === 0x0a) {
        i += 1; // soft break =\n
      } else if (h1 !== undefined && h2 !== undefined && hexValue(h1) >= 0 && hexValue(h2) >= 0) {
        out.push(hexValue(h1) * 16 + hexValue(h2));
        i += 2;
      } else {
        out.push(b); // not an escape ("=4x", "= 4"): text, as in Pigeonhole
      }
    } else {
      out.push(b);
    }
  }
  return Uint8Array.from(out);
}

/** A hex digit's value, or -1. Number.parseInt took "4x" as 4, " 4" as 4 and
 * "-1" as -1, decoding text into stray bytes. */
function hexValue(c: number): number {
  if (c >= 0x30 && c <= 0x39) return c - 0x30;
  if (c >= 0x41 && c <= 0x46) return c - 0x37;
  if (c >= 0x61 && c <= 0x66) return c - 0x57;
  return -1;
}

const B64_PAD = -2;
const B64_SKIP = -1;
const B64 = (() => {
  const t = new Int8Array(256).fill(B64_SKIP);
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  for (let i = 0; i < alphabet.length; i++) t[alphabet.charCodeAt(i)] = i;
  t[0x3d /* = */] = B64_PAD;
  return t;
})();

/**
 * Lenient base64: never throws, because malformed mail must not fail the
 * script (a thrown execute() skips every rule — see the host's fail-open).
 * Characters outside the alphabet are skipped; "=" ends the current quantum,
 * keeping the octets it completes, and decoding resumes after it, so padded
 * segments concatenated by a broken mailer read as one stream; a dangling
 * single character (length 4n+1) carries no whole octet and is dropped. A
 * prefix of the encoding therefore decodes to a prefix of the content, which
 * the truncation semantics rely on.
 */
function base64Decode(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(Math.floor((bytes.length * 3) / 4) + 3);
  let o = 0;
  let quad = 0;
  let n = 0;
  for (let i = 0; i < bytes.length; i++) {
    const v = B64[bytes[i]!]!;
    if (v === B64_SKIP) continue;
    if (v === B64_PAD) {
      if (n === 2) out[o++] = quad >> 4;
      else if (n === 3) {
        out[o++] = quad >> 10;
        out[o++] = (quad >> 2) & 0xff;
      }
      quad = 0;
      n = 0;
      continue;
    }
    quad = (quad << 6) | v;
    if (++n === 4) {
      out[o++] = quad >> 16;
      out[o++] = (quad >> 8) & 0xff;
      out[o++] = quad & 0xff;
      quad = 0;
      n = 0;
    }
  }
  if (n === 2) out[o++] = quad >> 4;
  else if (n === 3) {
    out[o++] = quad >> 10;
    out[o++] = (quad >> 2) & 0xff;
  }
  return out.subarray(0, o);
}

/** Returns transfer-decoded bytes, or null on an unknown encoding (skip part).
 * `cut`: the bytes are a prefix of the part, and decode to a prefix of it. */
function cteDecode(bytes: Uint8Array, cte: string, cut: boolean): Uint8Array | null {
  const e = cte.toLowerCase().trim();
  if (e === "" || e === "7bit" || e === "8bit" || e === "binary") return bytes;
  if (e === "base64") return base64Decode(bytes);
  if (e === "quoted-printable") return qpDecode(bytes, cut);
  return null;
}

// -------- charset decode --------

/** `cut`: the bytes are a prefix of the part, so a character the cut split is
 * dropped (a streaming decode holds it back) rather than decoded as U+FFFD,
 * which would be content the part does not have. */
function charsetDecode(bytes: Uint8Array, charset: string, cut: boolean): string {
  const cs = charset.toLowerCase().trim();
  if (cs === "" || cs === "utf-8" || cs === "utf8" || cs === "us-ascii" || cs === "ascii") {
    return new TextDecoder("utf-8").decode(bytes, { stream: cut });
  }
  if (cs === "iso-8859-1" || cs === "latin1" || cs === "iso8859-1") {
    // True Latin-1 (byte → code point). TextDecoder maps this label to cp1252.
    let s = "";
    for (const b of bytes) s += String.fromCharCode(b);
    return s;
  }
  try {
    return new TextDecoder(cs, { fatal: false }).decode(bytes, { stream: cut });
  } catch {
    return bytesToBinary(bytes); // unknown charset ⇒ keep raw (tolerate unknown charsets)
  }
}

// -------- media type + header parsing --------

export function parseMediaType(ct: string): { mediaType: string; params: Record<string, string> } {
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
export function parseMimeHeader(block: string): Map<string, string> {
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

/**
 * Split an entity at the blank line ending its header, reading line by line so
 * a part with NO header fields (it starts with the blank line — RFC 2046 §5.1
 * allows one) keeps its first body line, and a CRLF/LF mix still separates.
 * `header` excludes the final line break, `headerRaw` keeps it; `sep` says
 * whether a blank line was found at all (without one, everything is header).
 */
export function splitHeaderBody(b: string): { header: string; headerRaw: string; body: string; sep: boolean } {
  let pos = 0;
  for (;;) {
    const nl = b.indexOf("\n", pos);
    if (nl === -1) return { header: b, headerRaw: b, body: "", sep: false };
    const lineEnd = nl > pos && b.charCodeAt(nl - 1) === 13 /* \r */ ? nl - 1 : nl;
    if (lineEnd === pos) {
      const headerRaw = b.slice(0, pos);
      return { header: headerRaw.replace(/\r?\n$/, ""), headerRaw, body: b.slice(nl + 1), sep: true };
    }
    pos = nl + 1;
  }
}

// -------- the body test --------

/**
 * Bounds on the MIME structure the body test walks (RFC 5703 §11: part
 * matching must not deny service). Without them a nesting bomb overflowed the
 * call stack — a throw, which the host's fail-open turns into "skip every
 * rule" — and re-scanned the remaining body once per level. Past them a
 * no-match is "unknown": the rule does not fire, but nothing throws.
 *
 * Depth is Dovecot's message-parser limit (100, added for CVE-2020-12100);
 * nesting is cheap in steps. Parts stay at 1024, not Dovecot's 10000: every
 * body test charges every part, so 10000 tiny parts under a handful of body
 * rules exhaust a host's step budget, and its later tests go unknown.
 */
export const MAX_MIME_DEPTH = 100;

/**
 * Each leaf's text, per Message object: decoded, and reduced from HTML for
 * :text ("t") or not ("c"), keyed by mode and the leaf's place in the MIME
 * tree. Every body test walks the same tree, and decoding and HTML reduction
 * are linear in the part, so a script with many body tests redid them once per
 * test. null: a transfer encoding not decoded, so the part is skipped. The
 * cache lives as long as the Message object, so it also assumes the object's
 * top-level Content-Type and transfer encoding and bodyTruncated() do not
 * change: a host that reuses one object for a changed message gets stale text.
 */
const leafTexts = new WeakMap<Message, Map<string, string | null>>();

function leafCache(msg: Message): Map<string, string | null> {
  let m = leafTexts.get(msg);
  if (m === undefined) leafTexts.set(msg, (m = new Map()));
  return m;
}

/** The raw body as a binary string, per message: converting it costs about as
 * much as the rest of a body test, and every body test started with it. */
const rawBinaries = new WeakMap<Message, string>();

function rawBinary(msg: Message, raw: Uint8Array): string {
  let s = rawBinaries.get(msg);
  if (s === undefined) rawBinaries.set(msg, (s = bytesToBinary(raw)));
  return s;
}
export const MAX_MIME_PARTS = 1024;

export class TestBody implements Test {
  readonly matcher = new MatcherTest();
  raw = false;
  text = false;
  content: string[] = [];

  private matchOpts(d: RuntimeData) {
    return { maxMatchInputLength: d.script.opts.maxMatchInputLength };
  }

  /**
   * Three-valued over a truncated body (Message.bodyTruncated — the host's
   * read window cut the raw bytes). The walk threads a per-part `cut` flag so
   * a part that ENDS at a found boundary keeps exact match semantics — only
   * the tail that ran into the cut is a prefix — and a definite match from any
   * part is sound however much body was cut away. A NO-match over a truncated
   * body is always "unknown": whole parts (even whole part TYPES the :content
   * filter wanted) may sit past the cut, unseen. Comparisons the engine's own
   * match-input cap truncated surface as "unknown" through tryMatch the same
   * way, truncated body or not.
   */
  check(d: RuntimeData): Tri {
    const savedVars = d.matchVariables;
    try {
      const raw = d.msg.bodyRaw();
      if (raw === null) return false;
      const bodyCut = d.msg.bodyTruncated?.() ?? false;

      if (this.raw) {
        // :raw is ONE part by definition, so its count is exact even when cut.
        if (this.matcher.isCount()) return this.matcher.countMatches(d, 1);
        return this.matcher.tryMatch(d, rawBinary(d.msg, raw), this.matchOpts(d), bodyCut);
      }

      const topCt = d.msg.headerGet("content-type")[0] ?? "text/plain; charset=us-ascii";
      const topCte = d.msg.headerGet("content-transfer-encoding")[0] ?? "";
      const counter = { count: 0, parts: 0 };
      const flags = { unknown: false };
      const matched = this.walk(d, topCt, topCte, rawBinary(d.msg, raw), counter, bodyCut, flags, 0, "");
      if (matched) return true;
      if (this.matcher.isCount()) {
        const res = this.matcher.countMatches(d, counter.count);
        if (flags.unknown) {
          // Structure ran off the cut, so the visible count is a LOWER BOUND —
          // whole parts may sit past it. `ge`/`gt` already proven stay proven;
          // everything else could flip. (A cut that fell inside a LEAF leaves
          // the count exact: the tail extends a part, it does not add one.)
          return res === true && (this.matcher.relational === "ge" || this.matcher.relational === "gt")
            ? true
            : "unknown";
        }
        return res;
      }
      return flags.unknown ? "unknown" : false;
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

  /** Match one source, or count it. `cut` marks the source as a prefix of the
   * real content; an unknown from tryMatch lands in `flags`, never in the
   * boolean (which reports DEFINITE matches only). */
  private matchOrCount(
    d: RuntimeData,
    source: string,
    counter: { count: number; parts: number },
    cut: boolean,
    flags: { unknown: boolean },
  ): boolean {
    if (this.matcher.isCount()) {
      counter.count++;
      return false;
    }
    const r = this.matcher.tryMatch(d, source, this.matchOpts(d), cut);
    if (r === "unknown") {
      flags.unknown = true;
      return false;
    }
    return r;
  }

  /** `cut` = this part's content string may be a PREFIX of the real content
   * (the read-window cut fell inside it). Splitting on a FOUND boundary proves
   * everything before that boundary complete, so only the fragment that ran to
   * the end of a cut string inherits the flag. Returns definite matches only;
   * unknowns accumulate in `flags`. */
  private walk(
    d: RuntimeData,
    ctHeader: string,
    cteHeader: string,
    b: string,
    counter: { count: number; parts: number },
    cut: boolean,
    flags: { unknown: boolean },
    depth: number,
    path: string,
  ): boolean {
    d.budget.consume(1);
    // Structure past the caps is not examined, so a miss there is not proven:
    // "unknown", exactly as for a part the host's read window cut away.
    if (depth > MAX_MIME_DEPTH) {
      flags.unknown = true;
      return false;
    }
    const { mediaType, params } = parseMediaType(ctHeader || "text/plain; charset=us-ascii");
    const process = this.wantsPart(mediaType);

    if (mediaType.startsWith("multipart/")) {
      const boundary = params["boundary"];
      if (!boundary) {
        return process ? this.matchOrCount(d, b, counter, cut, flags) : false;
      }
      const parts = splitBoundary(b, boundary, cut);
      // parts[0] = prologue; find closing --boundary-- marker → epilogue; rest = nested
      let epilogue = "";
      let sawClose = false;
      const nested: string[] = [];
      for (let i = 1; i < parts.length; i++) {
        const p = parts[i]!;
        if (p.startsWith("--")) {
          sawClose = true;
          epilogue = skipDelimiterLineEnd(p.slice(2));
          break;
        }
        nested.push(skipDelimiterLineEnd(p));
      }
      // Which fragment ran into the cut: the epilogue when the close marker was
      // found, the last nested part otherwise (or the prologue when no boundary
      // was found at all — parts === [b]).
      const prologueCut = cut && parts.length === 1;
      // Before the close marker is seen the epilogue is unseen, after it the
      // epilogue runs into the cut: a prefix either way.
      const epilogueCut = cut;
      const lastNestedCut = cut && !sawClose;
      // A cut multipart whose close marker never appeared may CONTINUE past the
      // cut: whole sibling parts — even whole part TYPES a :content filter
      // wanted — can be hidden there. Any no-match at this level is therefore
      // unknown. (With the close marker in view the structure is complete and
      // only the epilogue is a prefix; a cut inside a LEAF needs no flag — its
      // comparison runs under prefix semantics, and its tail cannot hide
      // another part.)
      if (lastNestedCut) flags.unknown = true;
      if (process) {
        if (this.matcher.isCount()) {
          counter.count += 2;
        } else {
          if (this.matchOrCount(d, parts[0] ?? "", counter, prologueCut, flags)) return true;
          if (this.matchOrCount(d, epilogue, counter, epilogueCut, flags)) return true;
        }
      }
      for (let i = 0; i < nested.length; i++) {
        if (++counter.parts > MAX_MIME_PARTS) {
          flags.unknown = true;
          return false;
        }
        const partCut = lastNestedCut && i === nested.length - 1;
        const { header, body, sep } = splitHeaderBody(nested[i]!);
        // A last part cut inside its own header has no known type yet: it
        // would default to text/plain and be matched and counted as one. The
        // multipart is already unknown (lastNestedCut), so it is skipped.
        if (partCut && !sep) continue;
        const h = parseMimeHeader(header);
        if (
          this.walk(
            d,
            h.get("content-type") ?? "",
            h.get("content-transfer-encoding") ?? "",
            body,
            counter,
            partCut,
            flags,
            depth + 1,
            `${path}.${i}`,
          )
        ) {
          return true;
        }
      }
      return false;
    }

    if (mediaType === "message/rfc822") {
      const { header, headerRaw, body, sep } = splitHeaderBody(b);
      // No separator found in a cut string ⇒ the header block itself may be a
      // prefix; with a separator, the cut can only fall in the body (the tail).
      if (process && this.matchOrCount(d, headerRaw, counter, cut && !sep, flags)) return true;
      // A cut inside the nested header hides the entity's real type and
      // structure, so nothing walked below it can prove a miss.
      if (cut && !sep) flags.unknown = true;
      if (++counter.parts > MAX_MIME_PARTS) {
        flags.unknown = true;
        return false;
      }
      const h = parseMimeHeader(header);
      return this.walk(
        d,
        h.get("content-type") ?? "",
        h.get("content-transfer-encoding") ?? "",
        body,
        counter,
        cut,
        flags,
        depth + 1,
        `${path}.m`,
      );
    }

    // leaf
    if (!process) return false;
    const cache = leafCache(d.msg);
    const key = `${this.text ? "t" : "c"}${path}`;
    let text = cache.get(key);
    if (text === undefined) {
      // Charged by size once; later body tests read the cached text.
      d.budget.consume(b.length >> 10);
      text = this.leafText(b, cteHeader, mediaType, params, cut);
      cache.set(key, text);
    }
    if (text === null) return false; // unknown transfer-encoding → skip
    return this.matchOrCount(d, text, counter, cut, flags);
  }

  /** The text a leaf's body `b` reads as, or null for a transfer encoding not
   * decoded. Decoding never throws (see base64Decode). A cut leaf decodes to a
   * prefix of its content, which matchOrCount then reads under prefix
   * semantics, so every step drops what the cut left open instead of guessing
   * it. */
  private leafText(b: string, cteHeader: string, mediaType: string, params: Record<string, string>, cut: boolean): string | null {
    const decoded = cteDecode(binaryToBytes(b), cteHeader, cut);
    if (decoded === null) return null;
    let text: string;
    if (mediaType.startsWith("text/")) {
      text = charsetDecode(decoded, params["charset"] ?? "us-ascii", cut);
    } else {
      text = bytesToBinary(decoded); // non-text leaf: raw transfer-decoded octets
    }
    if (this.text && (mediaType === "text/html" || mediaType === "application/xhtml+xml")) {
      text = htmlToText(text, cut);
    }
    return text;
  }
}

/**
 * Split a multipart body at its delimiters: [prologue, ...chunks]. Each chunk
 * starts right after "--" boundary — so a close starts "--", and a part starts
 * with the rest of its delimiter line (see skipDelimiterLineEnd).
 *
 * One scan for the LF form, taking a CR before it as part of the delimiter:
 * scanning for CRLF first skipped an earlier bare-LF delimiter in a body with
 * mixed line endings, merging two parts. A match counts only where a delimiter
 * LINE can end (see delimiterEnds). That is stricter than RFC 2046 §5.1.1,
 * which lets the boundary merely start the line and instead forbids a sender
 * to nest a boundary the outer one prefixes (§5.1) — but mail breaks that
 * rule, and go-sieve, Go's, Python's and Thunderbird's parsers are strict the
 * same way: boundary "b" does not split the lines of a nested part whose
 * boundary is "b-alt", nor a content line "--bye".
 *
 * `cut`: `b` is a prefix of the real content. The end of the input then ends
 * no delimiter line (the rest of the line is unseen), and the last fragment
 * loses any tail that could still turn out to be a delimiter.
 */
export function splitBoundary(b: string, boundary: string, cut: boolean): string[] {
  const dash = `\n--${boundary}`;
  const parts: string[] = [];
  let pos = 0;
  if (b.startsWith(`--${boundary}`) && delimiterEnds(b, boundary.length + 2, cut)) {
    parts.push("");
    pos = boundary.length + 2;
  }
  for (;;) {
    let idx = b.indexOf(dash, pos);
    while (idx !== -1 && !delimiterEnds(b, idx + dash.length, cut)) idx = b.indexOf(dash, idx + 1);
    if (idx === -1) {
      parts.push(cut ? trimDelimiterTail(b, pos, boundary) : b.slice(pos));
      return parts;
    }
    const end = idx > pos && b.charCodeAt(idx - 1) === 13 /* \r */ ? idx - 1 : idx;
    parts.push(b.slice(pos, end));
    pos = idx + dash.length;
  }
}

/** Whether the text at `end`, right after a boundary, ends a delimiter line:
 * an optional closing "--", optional transport padding, then the line break —
 * or the end of a complete input. A lone "-" cannot ("b-alt" is another
 * boundary), and neither can text after the padding or the "--". */
function delimiterEnds(b: string, end: number, cut: boolean): boolean {
  let i = end;
  if (b.charCodeAt(i) === 45 /* - */ && b.charCodeAt(i + 1) === 45) i += 2;
  while (b.charCodeAt(i) === 32 || b.charCodeAt(i) === 9) i++;
  if (i >= b.length) return !cut;
  const c = b.charCodeAt(i);
  return c === 13 || c === 10;
}

/** Drop a delimiter line's transport padding (LWSP) and line break. */
export function skipDelimiterLineEnd(p: string): string {
  let i = 0;
  while (i < p.length && (p.charCodeAt(i) === 32 || p.charCodeAt(i) === 9)) i++;
  if (p.charCodeAt(i) === 13 && p.charCodeAt(i + 1) === 10) return p.slice(i + 2);
  if (p.charCodeAt(i) === 10) return p.slice(i + 1);
  return i > 0 ? p.slice(i) : p;
}

/**
 * The last fragment of a CUT body, without the tail that could still turn out
 * to be a delimiter: a final line that could still become a delimiter line
 * (see couldBeDelimiterLine), with the line break before it, or a lone
 * trailing CR. A shorter prefix of the real content is still a prefix, so this
 * only costs precision.
 */
function trimDelimiterTail(b: string, pos: number, boundary: string): string {
  const lf = b.lastIndexOf("\n");
  // The first line of a fragment after a delimiter is that delimiter line's
  // rest, never a content line; only the whole input (pos 0) starts on one.
  const lineStart = lf >= pos ? lf + 1 : pos === 0 ? 0 : -1;
  if (lineStart !== -1 && couldBeDelimiterLine(b.slice(lineStart), boundary)) {
    let end = lineStart === 0 ? 0 : lineStart - 1;
    if (end > pos && b.charCodeAt(end - 1) === 13 /* \r */) end--;
    return b.slice(pos, Math.max(end, pos));
  }
  return b.charCodeAt(b.length - 1) === 13 /* \r */ ? b.slice(pos, -1) : b.slice(pos);
}

/** Whether a final, cut line could still turn out to be a delimiter line: a
 * prefix of "--boundary--", or "--boundary" with an optional "--" and then
 * only padding, whose line break may lie past the cut. */
function couldBeDelimiterLine(line: string, boundary: string): boolean {
  if (`--${boundary}--`.startsWith(line)) return true;
  if (!line.startsWith(`--${boundary}`)) return false;
  let i = boundary.length + 2;
  if (line.charCodeAt(i) === 45 /* - */ && line.charCodeAt(i + 1) === 45) i += 2;
  while (line.charCodeAt(i) === 32 || line.charCodeAt(i) === 9) i++;
  return i >= line.length;
}
