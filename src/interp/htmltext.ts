// HTML → the text a reader sees, for body :text (RFC 5173 §5.2). It started as
// a whole-string port of go-sieve's htmltext.go (the host already bounds the
// body window, so nothing here needs to stream) and follows the WHATWG
// tokenizer further where that matters for a filter:
//
// - every construct that DROPS content up to a far terminator — a comment, a
//   script or style element, a raw-text element — is entered only where a
//   browser enters it, because a sender who can open one where a browser does
//   not hides the whole visible body from every body rule. So tags are read
//   with the tokenizer's attribute states (a ">" inside a quoted value does
//   not end the tag) and markup inside RCDATA/RAWTEXT elements is text;
// - which of those states a browser is in also depends on tree-builder rules
//   not modelled here: foreign content (svg, math), the select insertion mode,
//   the escape states inside a script. From the first such construct on
//   ("bounded" mode), nothing is dropped beyond the next ">" and raw text
//   (textarea, xmp, plaintext, CDATA) is kept, so the reduction can only show
//   more than a browser — stylesheets included;
// - comments, script, style, title, iframe, noembed and noframes drop with
//   their content; textarea and xmp keep theirs as text; plaintext runs to the
//   end; every other tag becomes a space;
// - character references decode as the WHATWG tokenizer decodes them (Go's
//   html.UnescapeString too, but for its quirks — see unescapeReference);
// - runs of ASCII white space and Unicode space separators (so U+00A0 from
//   &nbsp; too) collapse to one space, other white space stays inside the
//   text, and both ends are trimmed.
//
// One linear pass; the only regular expression is the literal closing-tag
// search inside a raw-text element.

import { HTML_ENTITIES, LONGEST_LEGACY_ENTITY } from "./html-entities.js";

/** White space held between two visible characters is bounded (go-sieve's
 * htmlPendingMax — counted here in UTF-16 units, there in UTF-8 bytes); past
 * it, further white space is folded into what is held. */
const PENDING_MAX = 64;
/** A character reference is collected from "&" up to this many characters. */
const ENTITY_MAX = 32;

const TAB = 0x09;
const LF = 0x0a;
const FF = 0x0c;
const CR = 0x0d;
const SPACE = 0x20;
const QUOT = 0x22;
const AMP = 0x26;
const APOS = 0x27;
const SLASH = 0x2f;
const SEMI = 0x3b;
const LT = 0x3c;
const EQ = 0x3d;
const GT = 0x3e;

/** Elements whose content is not markup (RAWTEXT/RCDATA/script data):
 * whether a reader sees it, and the closing tag that ends it — one that ends
 * where a tag name can ("</script>", "</script >", "</script/>"), so
 * "</scripts>" does not. */
const RAW_TEXT: ReadonlyMap<string, { keep: boolean; decode: boolean; closer: RegExp }> = new Map(
  (
    [
      ["script", false, false],
      ["style", false, false],
      ["iframe", false, false],
      ["noembed", false, false],
      ["noframes", false, false],
      ["title", false, true],
      ["textarea", true, true],
      ["xmp", true, false],
    ] as const
  ).map(([name, keep, decode]) => [name, { keep, decode, closer: new RegExp(`</${name}(?=[\\t\\n\\f\\r />]|$)`, "gi") }]),
);

/** Start tags past which a browser's tokenizer state depends on tree-builder
 * rules this reduction does not model (foreign content, the select mode, and
 * noscript, which is raw text where a renderer runs scripts). */
const BOUNDING_TAGS = new Set(["svg", "math", "select", "noscript"]);

/** What starts a raw state a browser SHOWS: inside a region kept here, a
 * browser reading it as markup (foreign content, select) can enter one that
 * outlasts the region. */
const VISIBLE_RAW_START = /<(?:xmp|textarea|plaintext)|<!\[CDATA\[/gi;

/** Accumulates visible text under the white-space rules. */
class TextOut {
  out = "";
  private pending = ""; // white space since the last visible character
  private emitted = false;

  space(): void {
    if (this.emitted && !this.pending.endsWith(" ") && this.pending.length < PENDING_MAX) this.pending += " ";
  }

  /** One code point. */
  char(ch: string): void {
    const cp = ch.codePointAt(0)!;
    if (isCollapsedSpace(cp)) {
      this.space();
    } else if (isOtherSpace(cp)) {
      // Kept in the middle of the text, trimmed from the ends.
      if (this.emitted && this.pending.length < PENDING_MAX) this.pending += ch;
    } else {
      this.visible(ch);
    }
  }

  /** Visible characters (no white space among them). */
  visible(text: string): void {
    this.out += this.pending + text;
    this.pending = "";
    this.emitted = true;
  }

  /** The text s[from, to), character references decoded when `decode`. Runs
   * of ordinary characters are copied whole. */
  text(s: string, from: number, to: number, decode: boolean): void {
    let i = from;
    while (i < to) {
      const c = s.charCodeAt(i);
      if (decode && c === AMP) {
        let j = i + 1;
        while (j < to && j - i < ENTITY_MAX && isEntityChar(s.charCodeAt(j))) j++;
        if (j < to && s.charCodeAt(j) === SEMI) j++;
        for (const ch of unescapeReference(s.slice(i, j))) this.char(ch);
        i = j;
        continue;
      }
      let j = i;
      while (j < to && isOrdinary(s.charCodeAt(j), decode)) j++;
      if (j > i) {
        this.visible(s.slice(i, j));
        i = j;
        continue;
      }
      const ch = String.fromCodePoint(s.codePointAt(i)!);
      this.char(ch);
      i += ch.length;
    }
  }
}

/**
 * `cut`: s is a prefix of the real input (the host's read window cut it), and
 * only the text nothing past the cut can change is returned, so it is a prefix
 * of what the whole input reduces to. Whatever was open at the cut is dropped:
 * a construct read to the end of the input (an unclosed tag, comment or
 * raw-text element), a final "<", a "<" bounded mode found no ">" for, and a
 * character reference the cut may have split.
 */
export function htmlToText(s: string, cut = false): string {
  const w = new TextOut();
  const ctx: Ctx = { bounded: false, gt: -2, escape: -2, rawStart: -2, amp: -2 };
  const n = s.length;
  let i = 0;
  let stable = 0; // w.out up to here is final, whatever follows the input
  let open = false; // a reading depended on where the input ends
  while (i < n) {
    const lt = s.indexOf("<", i);
    if (lt === -1) {
      const amp = cut ? openReference(s, i) : -1;
      if (amp === -1) {
        w.text(s, i, n, true);
      } else {
        w.text(s, i, amp, true);
        if (!open) stable = w.out.length;
        open = true;
        w.text(s, amp, n, true);
      }
      break;
    }
    if (lt > i) w.text(s, i, lt, true);
    if (!open) stable = w.out.length;
    if (lt + 1 < n && opensTag(s.charCodeAt(lt + 1))) {
      i = ctx.bounded ? boundedMarkup(s, lt + 1, w, ctx) : markup(s, lt + 1, w, ctx);
      if (i === n || (ctx.bounded && ctx.gt === -1)) open = true;
    } else {
      w.char("<");
      i = lt + 1;
      if (i === n) open = true;
    }
    if (!open) stable = w.out.length;
  }
  if (!open) stable = w.out.length;
  // Pending white space is the trailing white space, and goes.
  return cut ? w.out.slice(0, stable) : w.out;
}

/** The "&" of a character reference that runs to the end of s[from, …) and is
 * short enough that a further character could change how it decodes, or -1. */
function openReference(s: string, from: number): number {
  const amp = s.lastIndexOf("&");
  if (amp < from || s.length - amp > ENTITY_MAX) return -1;
  for (let k = amp + 1; k < s.length; k++) if (!isEntityChar(s.charCodeAt(k))) return -1;
  return amp;
}

type Ctx = {
  /** Past a construct that makes the browser's state undecidable here. */
  bounded: boolean;
  /** The next ">" at or after the last bounded search (-1: none left; -2:
   * not searched), so many "<" without a ">" scan the input once. */
  gt: number;
  /** The same for "<!--", searched from each script's content: an unbounded
   * search per script made many small scripts quadratic. */
  escape: number;
  /** The same for VISIBLE_RAW_START, searched from each bounded region. */
  rawStart: number;
  /** The same for "&", searched from each bounded region. */
  amp: number;
};

/**
 * Consume the construct whose "<" sits just before `j`, writing what it shows
 * to `w`; returns the index after it — `s.length` when it never closes, as the
 * tokenizer drops an open construct at the end of the input.
 */
function markup(s: string, j: number, w: TextOut, ctx: Ctx): number {
  const n = s.length;
  const c = s.charCodeAt(j);
  if (c === 0x21 /* ! */) {
    if (s.startsWith("!--", j)) return comment(s, j + 3, w);
    return bogusComment(s, j, w); // CDATA too: it is text only in foreign content
  }
  if (c === 0x3f /* ? */) return bogusComment(s, j, w);
  if (c === SLASH) {
    const d = s.charCodeAt(j + 1);
    if (d === GT) return j + 2; // "</>" is dropped
    if (!isAsciiAlpha(d)) return bogusComment(s, j, w);
    const tag = scanTag(s, j + 1);
    if (tag.next === -1) return n;
    w.space();
    return tag.next;
  }
  // A start tag.
  const tag = scanTag(s, j);
  if (tag.next === -1) return n;
  w.space();
  if (BOUNDING_TAGS.has(tag.name)) {
    ctx.bounded = true;
    return tag.next;
  }
  if (tag.name === "plaintext") {
    w.text(s, tag.next, n, false);
    return n;
  }
  const raw = RAW_TEXT.get(tag.name);
  if (raw === undefined) return tag.next;
  // The content runs to the element's own closing tag. A self-closing flag
  // does not stop it: "<script/>" still starts a script element.
  raw.closer.lastIndex = tag.next;
  const m = raw.closer.exec(s);
  const contentEnd = m === null ? n : m.index;
  if (raw.keep) w.text(s, tag.next, contentEnd, raw.decode);
  // "<!--" inside a script enters the escape states, where a nested "<script"
  // moves its end past this closing tag: what follows is undecidable here.
  if (tag.name === "script") {
    if (ctx.escape !== -1 && ctx.escape < tag.next) ctx.escape = s.indexOf("<!--", tag.next);
    if (ctx.escape !== -1 && ctx.escape < contentEnd) ctx.bounded = true;
  }
  if (m === null) return n;
  const close = scanTag(s, m.index + 2);
  if (close.next === -1) return n;
  w.space();
  return close.next;
}

/**
 * Bounded mode: every construct ends at the next ">" — or, with none left,
 * is not a construct at all and its "<" is text — so nothing past that ">"
 * is hidden. Raw text a browser could be showing stays text: CDATA (shown in
 * foreign content), and textarea, xmp and plaintext content (shown in HTML;
 * in foreign content a browser parses it as markup and shows less).
 */
function boundedMarkup(s: string, j: number, w: TextOut, ctx: Ctx): number {
  const n = s.length;
  if (s.startsWith("![CDATA[", j)) {
    const close = s.indexOf("]]>", j + 8);
    if (close === -1 || holdsVisibleRawStart(s, j + 8, close, ctx)) {
      keepRegion(s, j + 8, n, w, ctx);
      return n;
    }
    keepRegion(s, j + 8, close, w, ctx);
    return close + 3;
  }
  const gt = nextGt(s, j, ctx);
  if (gt === -1) {
    w.char("<");
    return j;
  }
  w.space();
  if (!isAsciiAlpha(s.charCodeAt(j))) return gt + 1;
  let k = j;
  while (k < gt && !endsTagName(s.charCodeAt(k))) k++;
  const name = k - j <= 16 ? s.slice(j, k).toLowerCase() : "";
  if (name === "plaintext") {
    keepRegion(s, gt + 1, n, w, ctx);
    return n;
  }
  const raw = RAW_TEXT.get(name);
  if (raw === undefined || !raw.keep) return gt + 1;
  raw.closer.lastIndex = gt + 1;
  const m = raw.closer.exec(s);
  if (m === null || holdsVisibleRawStart(s, gt + 1, m.index, ctx)) {
    keepRegion(s, gt + 1, n, w, ctx);
    return n;
  }
  keepRegion(s, gt + 1, m.index, w, ctx);
  return m.index; // the closing tag is read as markup next
}

/**
 * Whether s[from, to) — a region kept as text here — holds a start of a raw
 * state a browser shows. A browser reading the region as markup can enter that
 * state and stay in it past `to`, showing spans this mode would hide, so the
 * caller then shows the rest of the input as text: more, never less.
 */
function holdsVisibleRawStart(s: string, from: number, to: number, ctx: Ctx): boolean {
  if (ctx.rawStart !== -1 && ctx.rawStart < from) {
    VISIBLE_RAW_START.lastIndex = from;
    ctx.rawStart = VISIBLE_RAW_START.exec(s)?.index ?? -1;
  }
  return ctx.rawStart !== -1 && ctx.rawStart < to;
}

/**
 * Keep s[from, to) as text in bounded mode. Whether a browser decodes its
 * character references depends on a state undecidable here — raw (xmp,
 * plaintext, CDATA in foreign content: literal) or data/RCDATA (decoded) —
 * so a region holding "&" yields both readings, the literal one first.
 */
function keepRegion(s: string, from: number, to: number, w: TextOut, ctx: Ctx): void {
  w.text(s, from, to, false);
  if (ctx.amp !== -1 && ctx.amp < from) ctx.amp = s.indexOf("&", from);
  if (ctx.amp !== -1 && ctx.amp < to) {
    w.space();
    w.text(s, from, to, true);
  }
}

/** The first ">" at or after `j`, reusing the last search while it qualifies. */
function nextGt(s: string, j: number, ctx: Ctx): number {
  if (ctx.gt === -1 || ctx.gt >= j) return ctx.gt;
  ctx.gt = s.indexOf(">", j);
  return ctx.gt;
}

/** "<!--" … "-->" (or "--!>"); "<!-->" and "<!--->" close at once. `k` is just
 * after "<!--". */
function comment(s: string, k: number, w: TextOut): number {
  const n = s.length;
  if (s.charCodeAt(k) === GT) return closed(k + 1, w);
  if (s.startsWith("->", k)) return closed(k + 2, w);
  // One forward walk over "--": two independent indexOf searches would rescan
  // to the end of the input for every comment lacking the rarer form.
  for (let p = s.indexOf("--", k); p !== -1; p = s.indexOf("--", p + 1)) {
    if (s.charCodeAt(p + 2) === GT) return closed(p + 3, w);
    if (s.charCodeAt(p + 2) === 0x21 /* ! */ && s.charCodeAt(p + 3) === GT) return closed(p + 4, w);
  }
  return n;
}

/** A declaration, processing instruction or malformed end tag: up to the
 * first ">" — the tokenizer reads no quoting in any of them. */
function bogusComment(s: string, j: number, w: TextOut): number {
  const gt = s.indexOf(">", j);
  return gt === -1 ? s.length : closed(gt + 1, w);
}

function closed(next: number, w: TextOut): number {
  w.space();
  return next;
}

/**
 * Read a start or end tag from its name (at `k`) to its ">", through the
 * tokenizer's attribute states, so a ">" inside a quoted value does not end
 * it — while "<a =\"x>", "<a b==\">" and "<a/=\"x>" still end at the first
 * ">", as they do in a browser. `next` is the index after the ">", -1 when
 * the input ends inside the tag.
 */
function scanTag(s: string, k: number): { name: string; next: number; selfClosing: boolean } {
  const n = s.length;
  let p = k;
  while (p < n && !endsTagName(s.charCodeAt(p))) p++;
  const name = p - k <= 16 ? s.slice(k, p).toLowerCase() : "";
  for (;;) {
    // Before attribute name.
    while (p < n && isSpaceCode(s.charCodeAt(p))) p++;
    if (p >= n) return { name, next: -1, selfClosing: false };
    let c = s.charCodeAt(p);
    if (c === GT) return { name, next: p + 1, selfClosing: false };
    if (c === SLASH) {
      if (s.charCodeAt(p + 1) === GT) return { name, next: p + 2, selfClosing: true };
      p++; // anything else after "/" is read as before an attribute name
      continue;
    }
    // Attribute name; its first character is part of it even when it is "=".
    p++;
    while (p < n) {
      c = s.charCodeAt(p);
      if (isSpaceCode(c) || c === SLASH || c === GT || c === EQ) break;
      p++;
    }
    // After attribute name.
    while (p < n && isSpaceCode(s.charCodeAt(p))) p++;
    if (p >= n) return { name, next: -1, selfClosing: false };
    if (s.charCodeAt(p) !== EQ) continue; // "/", ">" or the next name
    p++;
    // Before attribute value.
    while (p < n && isSpaceCode(s.charCodeAt(p))) p++;
    if (p >= n) return { name, next: -1, selfClosing: false };
    c = s.charCodeAt(p);
    if (c === QUOT || c === APOS) {
      const close = s.indexOf(c === QUOT ? '"' : "'", p + 1);
      if (close === -1) return { name, next: -1, selfClosing: false };
      p = close + 1;
      continue; // after a quoted value, anything is read as before a name
    }
    if (c === GT) return { name, next: p + 1, selfClosing: false };
    // Unquoted value: up to white space or ">".
    while (p < n) {
      c = s.charCodeAt(p);
      if (isSpaceCode(c) || c === GT) break;
      p++;
    }
  }
}

/** windows-1252 for the C1 range, as the HTML tokenizer (and Go) map a numeric
 * reference in 0x80–0x9F; the five code points windows-1252 leaves undefined
 * map to themselves. */
const C1_REPLACEMENT = [
  0x20ac, 0x0081, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x008d,
  0x017d, 0x008f, 0x0090, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a,
  0x0153, 0x009d, 0x017e, 0x0178,
];

/**
 * Decode one collected reference ("&" + name or "#"-number + optional ";"),
 * returning the text it stands for — itself when it is not one. A full name
 * (";" included when present) is looked up first; failing that, the longest
 * legacy name that prefixes it decodes and the rest stays text ("&notit;" →
 * "¬it;"). This is the WHATWG tokenizer's behaviour, which Go's
 * html.UnescapeString follows except for four quirks this does not copy: Go
 * leaves a one-digit decimal reference without ";" undecoded ("&#5x"), turns
 * "&#x;" into U+FFFD, wraps numbers past 32 bits ("&#4294967361;" → "A"), and
 * lacks &nGt; and &nLt;.
 */
function unescapeReference(ref: string): string {
  if (ref.length < 2) return ref;
  if (ref.charCodeAt(1) === 0x23 /* # */) {
    const hex = ref[2] === "x" || ref[2] === "X";
    let k = hex ? 3 : 2;
    const start = k;
    while (k < ref.length && (hex ? isHexDigit(ref.charCodeAt(k)) : isDigit(ref.charCodeAt(k)))) k++;
    if (k === start) return ref;
    let cp = Number.parseInt(ref.slice(start, k), hex ? 16 : 10);
    if (k < ref.length && ref.charCodeAt(k) === SEMI) k++;
    if (cp >= 0x80 && cp <= 0x9f) cp = C1_REPLACEMENT[cp - 0x80]!;
    else if (cp === 0 || (cp >= 0xd800 && cp <= 0xdfff) || !(cp <= 0x10ffff)) cp = 0xfffd;
    return String.fromCodePoint(cp) + ref.slice(k);
  }
  const name = ref.slice(1);
  const whole = HTML_ENTITIES.get(name);
  if (whole !== undefined) return whole;
  for (let len = Math.min(name.length - 1, LONGEST_LEGACY_ENTITY); len > 1; len--) {
    const legacy = HTML_ENTITIES.get(name.slice(0, len));
    if (legacy !== undefined) return legacy + name.slice(len);
  }
  return ref;
}

function opensTag(c: number): boolean {
  return isAsciiAlpha(c) || c === SLASH || c === 0x21 /* ! */ || c === 0x3f; /* ? */
}

function endsTagName(c: number): boolean {
  return c === GT || c === SLASH || isSpaceCode(c);
}

function isAsciiAlpha(c: number): boolean {
  return (c >= 0x61 && c <= 0x7a) || (c >= 0x41 && c <= 0x5a);
}

function isSpaceCode(c: number): boolean {
  return c === SPACE || c === TAB || c === LF || c === FF || c === CR;
}

function isDigit(c: number): boolean {
  return c >= 0x30 && c <= 0x39;
}

function isHexDigit(c: number): boolean {
  return isDigit(c) || (c >= 0x61 && c <= 0x66) || (c >= 0x41 && c <= 0x46);
}

function isEntityChar(c: number): boolean {
  return isDigit(c) || isAsciiAlpha(c) || c === 0x23;
}

/** A UTF-16 unit that is neither white space of either kind nor, when
 * references decode, "&" — copied as is (surrogate pairs included). */
function isOrdinary(c: number, decode: boolean): boolean {
  if (c < 0x80) return c > SPACE ? !(decode && c === AMP) : !isSpaceCode(c) && c !== 0x0b;
  return !isCollapsedSpace(c) && !isOtherSpace(c);
}

/** White space that collapses to one space: ASCII white space as regexp's \s
 * sees it, and the Unicode space separators (Zs, listed out so the hot path
 * runs no regular expression per character). */
function isCollapsedSpace(cp: number): boolean {
  if (cp < 0x80) return isSpaceCode(cp);
  return cp === 0xa0 || cp === 0x1680 || (cp >= 0x2000 && cp <= 0x200a) || cp === 0x202f || cp === 0x205f || cp === 0x3000;
}

/** The rest of Go's unicode.IsSpace (\v, NEL, LINE and PARAGRAPH SEPARATOR):
 * kept inside the text, trimmed at its ends. */
function isOtherSpace(cp: number): boolean {
  return cp === 0x0b || cp === 0x85 || cp === 0x2028 || cp === 0x2029;
}
