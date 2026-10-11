// body :text over HTML (RFC 5173 §5.2: the text a reader sees). The reduction
// follows the HTML tokenizer, as go-sieve's htmltext.go does: script and style
// elements drop with their content, comments drop, every other tag is a space,
// character references decode (the full WHATWG table, as Go's
// html.UnescapeString), and whitespace collapses and trims. Each case pins the
// WHOLE reduced text with :is.

import { describe, expect, it } from "vitest";
import { run } from "./harness.js";

const quote = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
const eml = (html: string) =>
  `From: a@x\r\nTo: b@y\r\nContent-Type: text/html; charset=utf-8\r\n\r\n${html}`;
/** The text body :text sees for `html`, asserted by an exact :is match. */
const textIs = (html: string, text: string) =>
  run(`require "body"; if body :text :is ${quote(text)} { keep; }`, eml(html)).keep;

describe("HTML to text: what is a tag", () => {
  it("style and script elements drop with their content", () => {
    expect(textIs("<style>.p{display:none}</style><p>Hi</p>", "Hi")).toBe(true);
    expect(textIs("<script>var tracker=1;</script><p>Hi</p>", "Hi")).toBe(true);
    expect(textIs("<STYLE type=text/css>a{}</STYLE>x", "x")).toBe(true);
  });

  it("a script element ends only at a real closing tag", () => {
    expect(textIs("<script>a</scripts>b</script>c", "c")).toBe(true);
    expect(textIs("<script>a</script >b", "b")).toBe(true);
  });

  it("a tag name ends at whitespace, '/' or '>' only", () => {
    expect(textIs("<script-loader>kept</script-loader>", "kept")).toBe(true);
    expect(textIs("<script_x>kept", "kept")).toBe(true);
  });

  it("'<' not followed by a letter, '/', '!' or '?' is text", () => {
    expect(textIs("<p>5 < 10 dollars and <b>more</b></p>", "5 < 10 dollars and more")).toBe(true);
    expect(textIs("a <= b", "a <= b")).toBe(true);
  });

  it("comments drop, including a '>' inside them and the abrupt forms", () => {
    expect(textIs("<!-- a > b hidden -->Hi", "Hi")).toBe(true);
    expect(textIs("a<!-->b", "a b")).toBe(true);
    expect(textIs("a<!--->b", "a b")).toBe(true);
    expect(textIs("a<!-- x --!>b", "a b")).toBe(true);
  });

  it("an unterminated tag or comment runs to the end of the input", () => {
    expect(textIs("text <b class='x", "text")).toBe(true);
    expect(textIs("text <!-- never closed", "text")).toBe(true);
  });

  it("every other tag is one space between words", () => {
    expect(textIs("<p>a</p><p>b</p>", "a b")).toBe(true);
    expect(textIs("a<br/>b", "a b")).toBe(true);
  });
});

describe("HTML to text: character references", () => {
  it("decodes named references beyond the common few", () => {
    expect(textIs("don&rsquo;t &ldquo;x&rdquo; &euro;5 &hellip;", "don’t “x” €5 …")).toBe(true);
    expect(textIs("&alpha;&rarr;&check;", "α→✓")).toBe(true);
  });

  it("decodes numeric references, windows-1252 for 128–159, U+FFFD for invalid", () => {
    expect(textIs("&#8217;&#x2019;&#X2019;", "’’’")).toBe(true);
    expect(textIs("it&#146;s", "it’s")).toBe(true);
    expect(textIs("a&#0;b", "a\ufffdb")).toBe(true);
  });

  it("legacy names decode without ';', other names do not", () => {
    expect(textIs("&copy 2024", "© 2024")).toBe(true);
    expect(textIs("AT&T", "AT&T")).toBe(true);
    expect(textIs("&rsquo", "&rsquo")).toBe(true);
    expect(textIs("&notit;", "¬it;")).toBe(true);
  });

  it("&nbsp; collapses with the whitespace around it", () => {
    expect(textIs("a &nbsp; b", "a b")).toBe(true);
  });
});

describe("HTML to text: whitespace", () => {
  it("collapses runs and trims both ends", () => {
    expect(textIs("  \r\n <p>  a \t\n b  </p> \n", "a b")).toBe(true);
  });
});

// Hostile HTML must not hide text a reader sees. Every construct that drops
// content up to a far terminator (comments, script/style, raw-text elements)
// is entered only where a browser enters it; where the two would differ, the
// reduction may show MORE than a browser, never less.
describe("HTML to text: no drop state a browser would not enter", () => {
  it("a '>' inside a quoted attribute value does not end the tag", () => {
    expect(textIs('<img alt="><style>">Buy cheap pills now', "Buy cheap pills now")).toBe(true);
    expect(textIs('<a title="><!--">Buy cheap pills now<a title="-->">', "Buy cheap pills now")).toBe(true);
    expect(textIs("<a title='><script>'>Buy</a>", "Buy")).toBe(true);
    expect(textIs('<a href="x?a>b">link</a>', "link")).toBe(true);
  });

  it("a tag still ends at the first '>' where the tokenizer ends it", () => {
    expect(textIs('<a ="x>Buy pills">', 'Buy pills">')).toBe(true);
    expect(textIs('<a b==">Buy pills">', 'Buy pills">')).toBe(true);
    expect(textIs('<a/="x>Buy pills">', 'Buy pills">')).toBe(true);
    expect(textIs('<!DOCTYPE html PUBLIC "x>">Hi', '">Hi')).toBe(true);
  });

  it("an unclosed quote runs the tag to the end of the input", () => {
    expect(textIs('text <a href="x>more', "text")).toBe(true);
  });

  it("markup inside RCDATA/RAWTEXT elements is text, not a construct", () => {
    expect(textIs("<textarea><!--</textarea>Buy cheap pills now", "<!-- Buy cheap pills now")).toBe(true);
    expect(textIs("<xmp><style></xmp>Buy", "<style> Buy")).toBe(true);
    expect(textIs("<title><!--</title>Buy", "Buy")).toBe(true);
    expect(textIs("<iframe><style></iframe>Buy", "Buy")).toBe(true);
    expect(textIs("<noembed><!--</noembed>Buy", "Buy")).toBe(true);
    expect(textIs("<noframes><script></noframes>Buy", "Buy")).toBe(true);
    expect(textIs("<textarea>a &amp; b</textarea>", "a & b")).toBe(true);
  });

  it("past svg, math or select nothing is hidden beyond the next '>'", () => {
    // The browser's tokenizer state depends on tree-builder rules (foreign
    // content, integration points, the select mode) this reduction does not
    // model, so from such a tag on it keeps every drop bounded — CSS shows,
    // but no construct can hide the rest of the body.
    expect(textIs("<svg><style></svg>Buy cheap pills now", "Buy cheap pills now")).toBe(true);
    expect(textIs("<math><style></math>Buy", "Buy")).toBe(true);
    expect(textIs("<svg></svg><style>x</style>Buy", "x Buy")).toBe(true);
    expect(textIs("<select><style></select>W0", "W0")).toBe(true);
    expect(textIs("<table><select><noembed></select>W0", "W0")).toBe(true);
    expect(textIs("<math><mi><mglyph><style></math>W0", "W0")).toBe(true);
    expect(textIs("<svg><desc><b></svg></b></desc><style></svg>W0", "W0")).toBe(true);
    expect(textIs("<svg><foreignObject><div></svg></div></foreignObject><style></svg>W0", "W0")).toBe(true);
    expect(textIs("<math><mi><div><svg><g></math><style></svg>W0", "W0")).toBe(true);
    expect(textIs("<svg><desc><g></svg></desc><style></svg>W0", "W0")).toBe(true);
    expect(textIs("<math><annotation-xml encoding=text/html></br></annotation-xml><style></math>W0", "W0")).toBe(true);
    expect(textIs("<svg><font color=x><math></svg><style></math>W0", "W0")).toBe(true);
    expect(textIs("<svg><textarea><!--</textarea></svg>--><style></svg>W0", "<!-- --> W0")).toBe(true);
    expect(textIs("<svg><textarea></svg><style></textarea><!--</style>W0-->", "</svg><style> W0-->")).toBe(true);
  });

  it("there, CDATA and kept raw text still show", () => {
    expect(textIs("<svg><![CDATA[W0 > W1]]>W2", "W0 > W1W2")).toBe(true);
    expect(textIs("<svg><p><textarea><a W0 W1>", "<a W0 W1>")).toBe(true);
    expect(textIs("<math><xmp><!--</xmp>W0", "<!-- W0")).toBe(true);
  });

  it("a kept region holding a visible-raw start shows the rest as text", () => {
    // A browser in foreign content (or select) reads textarea/xmp/CDATA
    // content as markup and can enter xmp, textarea, plaintext or CDATA there,
    // showing spans as text past where this reduction's region ends.
    expect(
      textIs(
        "<svg><textarea></svg><xmp></textarea><Buy cheap pills now at example dot com>",
        "</svg><xmp></textarea><Buy cheap pills now at example dot com>",
      ),
    ).toBe(true);
    expect(textIs("<svg><textarea></svg><plaintext></textarea><Buy> <Click here>", "</svg><plaintext></textarea><Buy> <Click here>")).toBe(true);
    expect(textIs("<svg></svg><![CDATA[><xmp>]]><Buy cheap pills now>", "><xmp>]]><Buy cheap pills now>")).toBe(true);
    expect(textIs("<select><xmp><textarea></xmp><b W0>", "<textarea></xmp><b W0>")).toBe(true);
    // Without such a start the region still ends at its closer.
    expect(textIs("<svg><textarea>a<b>c</textarea><i>d", "a<b>c d")).toBe(true);
  });

  it("noscript bounds what follows (it is raw text where scripting is on)", () => {
    expect(textIs("<noscript><style></noscript>W0", "W0")).toBe(true);
  });

  it("an escaped script (<!-- inside it) makes what follows bounded too", () => {
    expect(textIs("<script><!--<script></script><style></script>W0</style>", "W0")).toBe(true);
    expect(textIs("<script><!--<script></script><!--</script>W0-->", "W0-->")).toBe(true);
    // A plain script still drops exactly.
    expect(textIs("<script>x</script><style>y</style>W0", "W0")).toBe(true);
  });
});

describe("HTML to text: cost", () => {
  // Every search here must resume where the last one stopped: a search per
  // construct that runs to the end of the input is quadratic, and 1 MiB of
  // small scripts took 41 s. A generous bound — linear runs in milliseconds.
  it("many small constructs over a large input stay linear", { timeout: 30_000 }, () => {
    const units = ["<script>x</script>", "<!-- x -->", '<a title="x">', "<style>x</style>", "<"];
    const bounded = ["<a", "<![CDATA[x]]>", "<textarea>x</textarea>", "<xmp>"].map((u) => ["<svg>", u] as const);
    for (const [prefix, unit] of [...units.map((u) => ["", u] as const), ...bounded]) {
      const html = prefix + unit.repeat(Math.ceil(1_048_576 / unit.length));
      const t = performance.now();
      textIs(html, "");
      expect(performance.now() - t).toBeLessThan(2000);
    }
  });
});

describe("HTML to text: edges", () => {
  it("an unterminated script or style runs to the end of the input", () => {
    expect(textIs("a<script>b", "a")).toBe(true);
    expect(textIs("a<style>b</style", "a")).toBe(true);
    expect(textIs("a<script>b</script", "a")).toBe(true);
  });

  it("C1 references map through windows-1252, the five undefined ones to themselves", () => {
    expect(textIs("a&#129;b&#x8D;c&#143;d&#144;e&#157;f", "a\u0081b\u008dc\u008fd\u0090e\u009df")).toBe(true);
    expect(textIs("&#128;&#159;", "€Ÿ")).toBe(true);
  });

  it("long and two-code-point references decode", () => {
    expect(textIs("&CounterClockwiseContourIntegral;", "∳")).toBe(true);
    expect(textIs("&NotEqualTilde;", "\u2242\u0338")).toBe(true);
  });

  it("follows WHATWG where Go's html.UnescapeString differs", () => {
    expect(textIs("&#5x", "\u0005x")).toBe(true);
    expect(textIs("&#x;", "&#x;")).toBe(true);
    expect(textIs("&#4294967361;", "\ufffd")).toBe(true);
    expect(textIs("&nGt;", "\u226b\u20d2")).toBe(true);
  });

  it("other white space stays inside the text and trims at its ends", () => {
    expect(textIs("a\u000bb\u2028c", "a\u000bb\u2028c")).toBe(true);
    expect(textIs("\u2028a\u2028", "a")).toBe(true);
    expect(textIs("a\u3000\u3000b", "a b")).toBe(true);
  });

  it("white space held between two characters is bounded", () => {
    expect(textIs(`a${"\u2028".repeat(100)}b`, `a${"\u2028".repeat(64)}b`)).toBe(true);
  });
});
