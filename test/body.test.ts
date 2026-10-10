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

// RFC 2046 §5.1: the multipart splitter. A delimiter is "--" boundary at the
// start of a line, and it ends the line there (§5.1.1: only "--", transport
// padding, or the line break may follow), so a boundary that is a prefix of
// another boundary — or of a content line — does not split it. A part may have
// no header fields at all, and real mail mixes LF and CRLF.
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

  it("a nested boundary that extends the outer one does not split the nested part", () => {
    const eml = mp(
      "b",
      '--b\r\nContent-Type: multipart/alternative; boundary="b-alt"\r\n\r\n' +
        "--b-alt\r\nContent-Type: text/plain\r\n\r\nplain\r\n--b-alt--\r\n--b--\r\n",
    );
    expect(hit('body :content "text/plain" :is "plain"', eml)).toBe(true);
    expect(hit('body :content "text/plain" :is ""', eml)).toBe(false);
  });

  it("a content line that starts with the delimiter but continues is content", () => {
    const eml = mp("sep", "--sep\r\nContent-Type: text/plain\r\n\r\nabove\r\n--separator line\r\nbelow\r\n--sep--\r\n");
    expect(hit('body :text :contains "separator line"', eml)).toBe(true);
    expect(hit('body :content "text/plain" :contains "below"', eml)).toBe(true);
  });

  it("transport padding after the boundary still delimits", () => {
    const eml = mp("b", "--b  \r\nContent-Type: text/html\r\n\r\n<p>x</p>\r\n--b-- \r\n");
    expect(hit('body :content "text/html" :contains "<p>x</p>"', eml)).toBe(true);
  });

  it("a CR before the delimiter belongs to the delimiter, not the part", () => {
    const eml = mp("b", "--b\nContent-Type: text/plain\n\nexact\r\n--b--\n");
    expect(hit('body :content "text/plain" :is "exact"', eml)).toBe(true);
  });

  it("a header block ended by a mixed CRLF + LF blank line still separates", () => {
    const eml = mp("b", "--b\r\nContent-Type: text/plain\r\n\nbody text\r\n--b--\r\n");
    expect(hit('body :content "text/plain" :is "body text"', eml)).toBe(true);
  });

  it("the closing delimiter of a prefix-boundary nested part is not the outer close", () => {
    const eml = mp(
      "b",
      '--b\r\nContent-Type: multipart/alternative; boundary="b-alt"\r\n\r\n' +
        "--b-alt\r\nContent-Type: text/plain\r\n\r\none\r\n--b-alt--\r\n" +
        "--b\r\nContent-Type: text/plain\r\n\r\ntwo\r\n--b--\r\n",
    );
    expect(hit('body :content "text/plain" :is "two"', eml)).toBe(true);
    expect(hit('body :content "text/plain" :is "one"', eml)).toBe(true);
  });
});
