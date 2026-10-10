// RFC 5173 body test.
//
// Uses a hand-rolled BYTE-level MIME walker (not a general parser), so it walks
// the body as a "binary string" (one char per byte, 0–255) to keep indexOf/slice
// offsets byte-exact. Leaf text parts are transfer-decoded (QP/base64) then
// charset-decoded to UTF-8; :text HTML parts are stripped to text. Everything is
// linear/bounded (no backtracking regex on body content).

import { MatcherTest } from "./matcher.js";
import type { RuntimeData, Test, Tri } from "./runtime.js";

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

/**
 * Split an entity at the blank line ending its header, reading line by line so
 * a part with NO header fields (it starts with the blank line — RFC 2046 §5.1
 * allows one) keeps its first body line, and a CRLF/LF mix still separates.
 * `header` excludes the final line break, `headerRaw` keeps it; `sep` says
 * whether a blank line was found at all (without one, everything is header).
 */
function splitHeaderBody(b: string): { header: string; headerRaw: string; body: string; sep: boolean } {
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
        return this.matcher.tryMatch(d, bytesToBinary(raw), this.matchOpts(d), bodyCut);
      }

      const topCt = d.msg.headerGet("content-type")[0] ?? "text/plain; charset=us-ascii";
      const topCte = d.msg.headerGet("content-transfer-encoding")[0] ?? "";
      const counter = { count: 0 };
      const flags = { unknown: false };
      const matched = this.walk(d, topCt, topCte, bytesToBinary(raw), counter, bodyCut, flags);
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
    counter: { count: number },
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
    counter: { count: number },
    cut: boolean,
    flags: { unknown: boolean },
  ): boolean {
    d.budget.consume(1);
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
        const partCut = lastNestedCut && i === nested.length - 1;
        const { header, body, sep } = splitHeaderBody(nested[i]!);
        // A last part cut inside its own header has no known type yet: it
        // would default to text/plain and be matched and counted as one. The
        // multipart is already unknown (lastNestedCut), so it is skipped.
        if (partCut && !sep) continue;
        const h = parseMimeHeader(header);
        if (
          this.walk(d, h.get("content-type") ?? "", h.get("content-transfer-encoding") ?? "", body, counter, partCut, flags)
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
      const h = parseMimeHeader(header);
      return this.walk(d, h.get("content-type") ?? "", h.get("content-transfer-encoding") ?? "", body, counter, cut, flags);
    }

    // leaf
    if (!process) return false;
    let decoded: Uint8Array | null;
    try {
      decoded = cteDecode(binaryToBytes(b), cteHeader);
    } catch (e) {
      // A cut base64 leaf can be undecodable at the ragged edge (atob length
      // rules) — that is "content unknown", not a script error. An untruncated
      // leaf keeps throwing: malformed input, the host's fail-open handles it.
      if (cut) {
        flags.unknown = true;
        return false;
      }
      throw e;
    }
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
    return this.matchOrCount(d, text, counter, cut, flags);
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
function splitBoundary(b: string, boundary: string, cut: boolean): string[] {
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
function skipDelimiterLineEnd(p: string): string {
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
