// body (RFC 5173) — 10 guarded body evaluations, driven Result-style:
// `if body ... { keep; }` asserts the body test returns true (an inversion of
// the guard form `if not body { test_fail }`).

import { describe, expect, it } from "vitest";
import { run } from "./harness.js";

const bodyMatches = (script: string, eml: string) => run(script, eml).keep === true;

describe("body", () => {
  it("single-part quoted-printable HTML :text + :content", () => {
    const eml = `From: shop@example.com
To: steven@example.com
Subject: Order
Content-Type: text/html; charset=utf-8
Content-Transfer-Encoding: quoted-printable

<html><body><p>Bestellung best=C3=A4tigt</p></body></html>
`;
    expect(bodyMatches('require "body"; if body :text :contains "Bestellung bestätigt" { keep; }', eml)).toBe(true);
    expect(bodyMatches('require "body"; if body :content "text/html" :contains "Bestellung" { keep; }', eml)).toBe(true);
  });

  it("single-part base64 HTML :text", () => {
    const eml = `From: shop@example.com
To: steven@example.com
Subject: Order
Content-Type: text/html; charset=utf-8
Content-Transfer-Encoding: base64

PGh0bWw+PGJvZHk+PHA+QmVzdGVsbHVuZyBiZXN0w6R0aWd0PC9wPjwvYm9keT48L2h0bWw+
`;
    expect(bodyMatches('require "body"; if body :text :contains "Bestellung bestätigt" { keep; }', eml)).toBe(true);
  });

  it("single-part quoted-printable plain text", () => {
    const eml = `From: shop@example.com
To: steven@example.com
Subject: Order
Content-Type: text/plain; charset=utf-8
Content-Transfer-Encoding: quoted-printable

Bestellung best=C3=A4tigt
`;
    expect(bodyMatches('require "body"; if body :text :contains "Bestellung bestätigt" { keep; }', eml)).toBe(true);
  });

  it("legacy charset ISO-8859-1 and windows-1252", () => {
    const iso = `From: a@x
To: b@y
Content-Type: text/html; charset=iso-8859-1
Content-Transfer-Encoding: quoted-printable

<html><body>Bestellung best=E4tigt</body></html>
`;
    const cp = `From: a@x
To: b@y
Content-Type: text/html; charset=windows-1252
Content-Transfer-Encoding: quoted-printable

<html><body>Bestellung best=E4tigt =96 danke</body></html>
`;
    expect(bodyMatches('require "body"; if body :text :contains "Bestellung bestätigt" { keep; }', iso)).toBe(true);
    expect(bodyMatches('require "body"; if body :text :contains "Bestellung bestätigt" { keep; }', cp)).toBe(true);
  });

  it("HTML entities (&nbsp;/&auml;) and tags inside words", () => {
    const ent = `From: a@x
To: b@y
Content-Type: text/html; charset=utf-8

<html><body><p>Bestellung&nbsp;best&auml;tigt</p></body></html>
`;
    const tags = `From: a@x
To: b@y
Content-Type: text/html; charset=utf-8

<html><body><p>Bestellung <b>best</b>ätigt</p></body></html>
`;
    expect(bodyMatches('require "body"; if body :text :contains "Bestellung bestätigt" { keep; }', ent)).toBe(true);
    expect(bodyMatches('require "body"; if body :text :contains "Bestellung best ätigt" { keep; }', tags)).toBe(true);
  });

  it("multipart/alternative without preamble", () => {
    const eml = `From: shop@example.com
To: steven@example.com
Subject: Order
Content-Type: multipart/alternative; boundary=frontier

--frontier
Content-Type: text/plain; charset=utf-8

Plain variant text
--frontier
Content-Type: text/html; charset=utf-8
Content-Transfer-Encoding: quoted-printable

<html><body>HTML variant best=C3=A4tigt</body></html>
--frontier--
`;
    expect(bodyMatches('require "body"; if body :text :contains "Plain variant text" { keep; }', eml)).toBe(true);
    expect(bodyMatches('require "body"; if body :text :contains "HTML variant bestätigt" { keep; }', eml)).toBe(true);
  });

  it(":raw matches the whole undecoded body", () => {
    const eml = `From: a@x
To: b@y
Content-Type: text/plain

hello raw world
`;
    expect(bodyMatches('require "body"; if body :raw :contains "hello raw world" { keep; }', eml)).toBe(true);
  });

  it("require gate + single-transform rule", () => {
    expect(() => run('if body :text "x" { keep; }', "")).toThrow();
    expect(() => run('require "body"; if body :raw :text "x" { keep; }', "")).toThrow();
  });
});

// RFC 2046 §5.1: the multipart splitter, which reads parts as core's MIME
// walker does (see mime-part-list-core.test.ts). A part ends where a line
// starts with the boundary and then "-", padding or the line break, so a
// content line that merely starts with the boundary does not end it, but a
// nested boundary the outer one prefixes ("b-alt" under "b") does, and the
// list goes on only at a delimiter line. A part may have no header fields at
// all; the first delimiter line sets LF or CRLF for the multipart.
describe("body multipart structure (RFC 2046 §5.1)", () => {
  const mp = (boundary: string, body: string) =>
    `From: a@x\r\nTo: b@y\r\nContent-Type: multipart/mixed; boundary="${boundary}"\r\n\r\n${body}`;
  const hit = (script: string, eml: string) => run(`require "body"; if ${script} { keep; }`, eml).keep;

  it("a part with no header fields keeps its first body line (default text/plain)", () => {
    const eml = mp("b", "--b\r\n\r\nhello\r\n\r\nworld\r\n--b--\r\n");
    expect(hit('body :contains "hello"', eml)).toBe(true);
    expect(hit('body :content "text/plain" :contains "hello"', eml)).toBe(true);
  });

  it("an earlier LF delimiter is not skipped for a later CRLF one", () => {
    const eml = mp(
      "b",
      "--b\nContent-Type: text/html\n\n<b>alpha</b>\n--b\nContent-Type: text/plain\n\nbeta\r\n--b--\r\n",
    );
    expect(hit('body :content "text/plain" :contains "beta"', eml)).toBe(true);
    expect(hit('body :content "text/html" :contains "alpha"', eml)).toBe(true);
    expect(hit('body :text :contains "Content-Type"', eml)).toBe(false);
  });

  it("a nested boundary that extends the outer one with '-' ends the outer part", () => {
    // "--b-alt" ends the nested part's body before it starts, so the nested
    // multipart has only the empty text/plain child core synthesizes.
    const eml = mp(
      "b",
      '--b\r\nContent-Type: multipart/alternative; boundary="b-alt"\r\n\r\n' +
        "--b-alt\r\nContent-Type: text/plain\r\n\r\nplain\r\n--b-alt--\r\n--b--\r\n",
    );
    expect(hit('body :content "text/plain" :is "plain"', eml)).toBe(false);
    expect(hit('body :content "text/plain" :is ""', eml)).toBe(true);
  });

  it("a content line that starts with the delimiter but continues is content", () => {
    const eml = mp("sep", "--sep\r\nContent-Type: text/plain\r\n\r\nabove\r\n--separator line\r\nbelow\r\n--sep--\r\n");
    expect(hit('body :text :contains "separator line"', eml)).toBe(true);
    expect(hit('body :content "text/plain" :contains "below"', eml)).toBe(true);
  });

  it("transport padding after the boundary still delimits", () => {
    const eml = mp("b", "--b  \r\nContent-Type: text/html\r\n\r\n<p>x</p>\r\n--b-- \t\r\nepilogue\r\n");
    expect(hit('body :content "text/html" :contains "<p>x</p>"', eml)).toBe(true);
    expect(hit('body :content "multipart" :is "epilogue\r\n"', eml)).toBe(true);
  });

  it("text after padding on a delimiter line ends the part, and the list", () => {
    const eml = mp("sep", "--sep\r\nContent-Type: text/plain\r\n\r\nabove\r\n--sep is the separator\r\nbelow\r\n--sep--\r\n");
    expect(hit('body :content "text/plain" :is "above"', eml)).toBe(true);
    expect(hit('body :content "text/plain" :contains "below"', eml)).toBe(false);
  });

  it("'--' after the boundary ends the part even where the line goes on", () => {
    // Outer "b", nested "b--x": "--b--x" ends the outer part before the nested
    // body starts, and is no close delimiter, so the outer list ends there.
    const eml = mp(
      "b",
      '--b\r\nContent-Type: multipart/alternative; boundary="b--x"\r\n\r\n' +
        "--b--x\r\nContent-Type: text/plain\r\n\r\ninner\r\n--b--x--\r\n" +
        "--b\r\nContent-Type: text/plain\r\n\r\nouter\r\n--b--\r\n",
    );
    expect(hit('body :content "text/plain" :is "inner"', eml)).toBe(false);
    expect(hit('body :content "text/plain" :is "outer"', eml)).toBe(false);
    expect(hit('body :content "text/plain" :is ""', eml)).toBe(true);
  });

  it("a delimiter at the very end of a complete body ends the part", () => {
    expect(hit('body :content "text/plain" :is "x"', mp("b", "--b\r\nContent-Type: text/plain\r\n\r\nx\r\n--b"))).toBe(
      true,
    );
  });

  it("a CR before the delimiter belongs to the delimiter in CRLF mode, to the part in LF mode", () => {
    const crlf = mp("b", "--b\r\nContent-Type: text/plain\n\nexact\r\n--b--\n");
    expect(hit('body :content "text/plain" :is "exact"', crlf)).toBe(true);
    const lf = mp("b", "--b\nContent-Type: text/plain\n\nexact\r\n--b--\n");
    expect(hit('body :content "text/plain" :is "exact"', lf)).toBe(false);
    expect(hit('body :content "text/plain" :matches "exact?"', lf)).toBe(true);
  });

  it("a header block ended by a mixed CRLF + LF blank line still separates", () => {
    const eml = mp("b", "--b\r\nContent-Type: text/plain\r\n\nbody text\r\n--b--\r\n");
    expect(hit('body :content "text/plain" :is "body text"', eml)).toBe(true);
    // The first blank line ends the header even when a CRLF one comes later.
    const later = mp("b", "--b\r\nContent-Type: text/html\r\n\nfoo\r\n\r\nbar\r\n--b--\r\n");
    expect(hit('body :content "text/html" :contains "foo"', later)).toBe(true);
  });

  it("a prefix-boundary nested part hides the outer parts after it too", () => {
    const eml = mp(
      "b",
      '--b\r\nContent-Type: multipart/alternative; boundary="b-alt"\r\n\r\n' +
        "--b-alt\r\nContent-Type: text/plain\r\n\r\none\r\n--b-alt--\r\n" +
        "--b\r\nContent-Type: text/plain\r\n\r\ntwo\r\n--b--\r\n",
    );
    expect(hit('body :content "text/plain" :is "two"', eml)).toBe(false);
    expect(hit('body :content "text/plain" :is "one"', eml)).toBe(false);
    expect(
      run('require ["body","relational"]; if body :content "text/plain" :count "eq" "1" { keep; }', eml).keep,
    ).toBe(true);
  });
});
