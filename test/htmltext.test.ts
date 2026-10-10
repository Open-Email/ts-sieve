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
    expect(textIs("a&#0;b", "a�b")).toBe(true);
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
