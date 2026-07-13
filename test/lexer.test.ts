// Lexer conformance fixtures. Same scripts, same expected token streams +
// positions. `null` expected == the lexer must throw.

import { describe, expect, it } from "vitest";
import { lex } from "../src/lexer/lex.js";
import type { Quantifier, Token } from "../src/lexer/token.js";

const ident = (text: string, line: number, col: number): Token => ({ kind: "identifier", text, line, col });
const num = (value: number, quantifier: Quantifier, line: number, col: number): Token => ({
  kind: "number",
  value,
  quantifier,
  line,
  col,
});
const str = (text: string, line: number, col: number): Token => ({ kind: "string", text, line, col });
const t = (kind: Extract<Token, { kind: "listStart" }>["kind"] | Token["kind"], line: number, col: number): Token =>
  ({ kind, line, col }) as Token;

function expectLex(script: string, tokens: Token[] | null) {
  if (tokens === null) {
    expect(() => lex(script)).toThrow();
  } else {
    expect(lex(script)).toEqual(tokens);
  }
}

describe("lexer", () => {
  it("empty", () => expectLex(``, []));

  it("empty list", () => expectLex(`[]`, [t("listStart", 1, 1), t("listEnd", 1, 2)]));

  it("string list", () =>
    expectLex(`[ "hello1" , "hello2" ]`, [
      t("listStart", 1, 1),
      str("hello1", 1, 3),
      t("comma", 1, 12),
      str("hello2", 1, 14),
      t("listEnd", 1, 23),
    ]));

  it("multiline quoted string normalises LF to CRLF", () =>
    expectLex(`"multi\nline\nstring"`, [str("multi\r\nline\r\nstring", 1, 1)]));

  it("unterminated quoted string errors", () => expectLex(`" and so it goes... `, null));

  it("list then identifier", () =>
    expectLex(`[ "hello" ] id`, [
      t("listStart", 1, 1),
      str("hello", 1, 3),
      t("listEnd", 1, 11),
      ident("id", 1, 13),
    ]));

  it("block with multiline comment and quantifier", () =>
    expectLex(
      `[ "hello" ]
/* also a comment
whatever # aaaa
"still a comment"
{}
*/
{ identifier :size 123K }`,
      [
        t("listStart", 1, 1),
        str("hello", 1, 3),
        t("listEnd", 1, 11),
        t("blockStart", 7, 1),
        ident("identifier", 7, 3),
        t("colon", 7, 14),
        ident("size", 7, 15),
        num(123, "K", 7, 20),
        t("blockEnd", 7, 25),
      ],
    ));

  it("text: multiline string", () =>
    expectLex(
      `set "message" text:
From: sirius@example.org
To: nico@frop.example.com
Subject: Frop!

Frop!
.
`,
      [
        ident("set", 1, 1),
        str("message", 1, 5),
        str(
          "From: sirius@example.org\r\n" +
            "To: nico@frop.example.com\r\n" +
            "Subject: Frop!\r\n" +
            "\r\n" +
            "Frop!\r\n",
          1,
          15,
        ),
      ],
    ));

  it("text: multiline string with dot-stuffing", () =>
    expectLex(
      `set "message" text:
From: sirius@example.org
To: nico@frop.example.com
Subject: Frop!

..
Frop!
.
`,
      [
        ident("set", 1, 1),
        str("message", 1, 5),
        str(
          "From: sirius@example.org\r\n" +
            "To: nico@frop.example.com\r\n" +
            "Subject: Frop!\r\n" +
            "\r\n" +
            ".\r\n" +
            "Frop!\r\n",
          1,
          15,
        ),
      ],
    ));

  it("text: with comment marker and dot lines", () =>
    expectLex(
      `set "text" text: # Comment
Line 1
.Line 2
..Line 3
.Line 4
Line 5
.
;`,
      [
        ident("set", 1, 1),
        str("text", 1, 5),
        str("Line 1\r\n.Line 2\r\n.Line 3\r\n.Line 4\r\nLine 5\r\n", 1, 12),
        t("semicolon", 8, 1),
      ],
    ));
});
