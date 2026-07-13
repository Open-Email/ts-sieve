// body (RFC 5173) — 10 guarded body evaluations, driven Result-style:
// `if body ... { keep; }` asserts the body test returns true (an inversion of
// the guard form `if not body { test_fail }`).

import { describe, expect, it } from "vitest";
import { R, run } from "./harness.js";

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
