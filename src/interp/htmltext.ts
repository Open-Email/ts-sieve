// HTML → the text a reader sees, for body :text (RFC 5173 §5.2). A port of
// go-sieve's htmltext.go over a whole string (the host already bounds the body
// window, so nothing here needs to stream):
//
// - script and style elements are dropped with their content, comments are
//   dropped, every other tag becomes a space;
// - what counts as a tag follows the HTML tokenizer: "<" opens one only when an
//   ASCII letter, "/", "!" or "?" follows, so "5 < 10" is text; a tag name ends
//   at whitespace, "/" or ">"; a tag with no ">" runs to the end of the input,
//   as does a comment with no "-->";
// - character references decode as Go's html.UnescapeString decodes them;
// - runs of ASCII whitespace and Unicode space separators (so U+00A0 from
//   &nbsp; too) collapse to one space, and white space is trimmed from both
//   ends.
//
// One linear pass; no regular expression runs over the input except the
// literal closing-tag search inside script/style.

import { HTML_ENTITIES, LONGEST_LEGACY_ENTITY } from "./html-entities.js";

/** Whitespace held between two visible characters is bounded (go-sieve's
 * htmlPendingMax); past it, further white space is folded into what is held. */
const PENDING_MAX = 64;
/** A character reference is collected from "&" up to this many characters. */
const ENTITY_MAX = 32;

const LT = 0x3c;
const GT = 0x3e;
const AMP = 0x26;
const SEMI = 0x3b;

export function htmlToText(s: string): string {
  let out = "";
  let pending = ""; // white space since the last visible character
  let emitted = false;

  const space = () => {
    if (emitted && !pending.endsWith(" ") && pending.length < PENDING_MAX) pending += " ";
  };
  const visible = (ch: string) => {
    const cp = ch.codePointAt(0)!;
    if (isCollapsedSpace(cp)) {
      space();
    } else if (isOtherSpace(cp)) {
      // Kept in the middle of the text, trimmed from the ends.
      if (emitted && pending.length < PENDING_MAX) pending += ch;
    } else {
      out += pending + ch;
      pending = "";
      emitted = true;
    }
  };
  const visibleAll = (text: string) => {
    for (const ch of text) visible(ch);
  };

  const n = s.length;
  let i = 0;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === LT) {
      if (i + 1 < n && opensTag(s.charCodeAt(i + 1))) {
        i = skipTag(s, i + 1, space);
        continue;
      }
      visible("<");
      i++;
    } else if (c === AMP) {
      let j = i + 1;
      while (j < n && j - i < ENTITY_MAX && isEntityChar(s.charCodeAt(j))) j++;
      if (j < n && s.charCodeAt(j) === SEMI) j++;
      visibleAll(unescapeReference(s.slice(i, j)));
      i = j;
    } else {
      const cp = s.codePointAt(i)!;
      const ch = String.fromCodePoint(cp);
      visible(ch);
      i += ch.length;
    }
  }
  return out; // pending white space is the trailing white space, and goes
}

/**
 * Consume a tag, comment, or script/style element starting right after its
 * "<" (at `j`), calling `space` for each construct; returns the index after it
 * — `s.length` when it never closes, as the tokenizer drops an open construct.
 */
function skipTag(s: string, j: number, space: () => void): number {
  const n = s.length;
  if (s.startsWith("!--", j)) {
    const k = j + 3;
    // "<!-->" and "<!--->" are closed at once (HTML tokenizer).
    if (s.charCodeAt(k) === GT) return closed(k + 1, space);
    if (s.startsWith("->", k)) return closed(k + 2, space);
    // "-->" closes a comment, as does the "--!>" the tokenizer accepts. One
    // forward walk over "--": two independent indexOf searches would rescan to
    // the end of the input for every comment lacking the rarer form.
    for (let p = s.indexOf("--", k); p !== -1; p = s.indexOf("--", p + 1)) {
      if (s.charCodeAt(p + 2) === GT) return closed(p + 3, space);
      if (s.charCodeAt(p + 2) === 0x21 /* ! */ && s.charCodeAt(p + 3) === GT) return closed(p + 4, space);
    }
    return n;
  }
  let k = j;
  while (k < n && !endsTagName(s.charCodeAt(k))) k++;
  const name = k - j === 6 || k - j === 5 ? s.slice(j, k).toLowerCase() : "";
  const gt = s.indexOf(">", k);
  if (gt === -1) return n; // attributes are never text
  space();
  if (name !== "script" && name !== "style") return gt + 1;
  // The element's content is dropped up to its closing tag, which has to end
  // where a tag name can ("</script>", "</script >", "</script/>"), so
  // "</scripts>" does not end it.
  const end = new RegExp(`</${name}(?=[ \\t\\n\\f\\r/>]|$)`, "gi");
  end.lastIndex = gt + 1;
  const m = end.exec(s);
  if (m === null) return n;
  const close = s.indexOf(">", m.index + m[0].length);
  return close === -1 ? n : closed(close + 1, space);
}

function closed(next: number, space: () => void): number {
  space();
  return next;
}

/** windows-1252 for the C1 range, as the HTML tokenizer (and Go) map a
 * numeric reference in 0x80–0x9F. */
const C1_REPLACEMENT = [
  0x20ac, 0xfffd, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0xfffd,
  0x017d, 0xfffd, 0xfffd, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a,
  0x0153, 0xfffd, 0x017e, 0x0178,
];

/**
 * Decode one collected reference ("&" + name or "#"-number + optional ";"),
 * returning the text it stands for — itself when it is not one. Mirrors Go's
 * html.unescapeEntity: a full name (";" included when present) is looked up
 * first; failing that, the longest legacy name that prefixes it decodes and
 * the rest stays text ("&notit;" → "¬it;").
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
  return (c >= 0x61 && c <= 0x7a) || (c >= 0x41 && c <= 0x5a) || c === 0x2f || c === 0x21 || c === 0x3f;
}

function endsTagName(c: number): boolean {
  return c === GT || c === 0x2f || isSpaceCode(c);
}

function isSpaceCode(c: number): boolean {
  return c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0c || c === 0x0d;
}

function isDigit(c: number): boolean {
  return c >= 0x30 && c <= 0x39;
}

function isHexDigit(c: number): boolean {
  return isDigit(c) || (c >= 0x61 && c <= 0x66) || (c >= 0x41 && c <= 0x46);
}

function isEntityChar(c: number): boolean {
  return isDigit(c) || (c >= 0x61 && c <= 0x7a) || (c >= 0x41 && c <= 0x5a) || c === 0x23;
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
