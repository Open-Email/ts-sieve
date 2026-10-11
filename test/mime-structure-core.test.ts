// MIME structure read as core reads it.
//
// A part the Sieve engine does not see is a part no :mime or foreverypart rule
// can act on, while the user's mail client, served by core's MIME walker (a
// port of go-message), still shows it. The engine split parts differently:
// the last Content-Type of a part rather than the first, a ";" or quoted-pair
// inside a quoted boundary, RFC 2231 boundary*= and boundary*0=, a bare
// "multipart", an RFC 2047 encoded boundary. Each hid an attachment from an
// attachment rule. The engine now reads a part's Content-Type as core does.

import { describe, expect, it } from "vitest";
import { DummyPolicy, EnvelopeStatic, load, MessageStatic, newRuntimeData } from "../src/index.js";
import { ALL_EXTENSIONS, run } from "./harness.js";

const B = String.fromCharCode(92);
const exe = "Content-Type: application/x-msdownload\r\nContent-Disposition: attachment; filename=\"evil.exe\"\r\n\r\nMZ\r\n";
/** A message whose root is the multipart `contentType` with boundary `b`, a
 * text part and the exe part. */
const message = (contentType: string, b = "b") =>
  `From: a@x\r\nTo: b@y\r\nSubject: s\r\nContent-Type: multipart/mixed; boundary=outer\r\n\r\n` +
  `--outer\r\n${contentType}\r\n\r\n` +
  `--${b}\r\nContent-Type: text/plain\r\n\r\nhello\r\n--${b}\r\n${exe}--${b}--\r\n` +
  `--outer--\r\n`;

const anychild = 'require ["fileinto","mime"]; if header :mime :anychild :contenttype "content-type" "application/x-msdownload" { fileinto "Junk"; }';
const loop = 'require ["mime","foreverypart"]; foreverypart { if header :mime :param "filename" :matches "content-disposition" "*.exe" { discard; stop; } }';

const shapes: [string, string, string?][] = [
  ["a plain boundary (the control)", "Content-Type: multipart/mixed; boundary=b"],
  ["two Content-Type fields, the first multipart", "Content-Type: multipart/mixed; boundary=b\r\nContent-Type: text/plain"],
  ["RFC 2231 boundary*=", "Content-Type: multipart/mixed; boundary*=utf-8''b"],
  ["RFC 2231 continuations", "Content-Type: multipart/mixed; boundary*0=b; boundary*1=c", "bc"],
  ["a ';' inside a quoted boundary", 'Content-Type: multipart/mixed; boundary="a;b"', "a;b"],
  ["a quoted-pair in the boundary", `Content-Type: multipart/mixed; boundary="a${B}"b"`, 'a"b'],
  ["a bare multipart", "Content-Type: multipart; boundary=b"],
  ["an RFC 2047 encoded boundary", 'Content-Type: multipart/mixed; boundary="=?utf-8?q?b?="'],
];

describe("an attachment behind each Content-Type shape is seen", () => {
  for (const [name, ct, b] of shapes) {
    it(name, () => {
      const m = message(ct, b);
      expect(run(anychild, m).fileinto).toEqual(["Junk"]);
      expect(run(loop, m)).toMatchObject({ implicitKeep: false, keep: false });
    });
  }
});

describe("the body test walks the same structure", () => {
  const body = 'require ["fileinto","body"]; if body :content "application/x-msdownload" :contains "MZ" { fileinto "Junk"; }';
  for (const [name, ct, b] of shapes) {
    it(name, () => {
      expect(run(body, message(ct, b)).fileinto).toEqual(["Junk"]);
    });
  }
});

describe("what core does not split, neither does the engine", () => {
  it("a comment in the type: core parses no boundary, so the parts are one text part", () => {
    const m = message("Content-Type: multipart/mixed (note); boundary=b");
    expect(run(anychild, m).fileinto).toEqual([]);
  });

  it("two different boundary parameters: core parses no parameters", () => {
    const m = message("Content-Type: multipart/mixed; boundary=b; boundary=c");
    expect(run(anychild, m).fileinto).toEqual([]);
  });
});

describe("a nested message/global is descended, as message/rfc822 is", () => {
  it("its attachment is seen", () => {
    const inner = `From: c@x\r\nContent-Type: multipart/mixed; boundary=b\r\n\r\n--b\r\nContent-Type: text/plain\r\n\r\nhi\r\n--b\r\n${exe}--b--\r\n`;
    const m = `From: a@x\r\nContent-Type: multipart/mixed; boundary=outer\r\n\r\n--outer\r\nContent-Type: message/global\r\n\r\n${inner}--outer--\r\n`;
    expect(run(anychild, m).fileinto).toEqual(["Junk"]);
  });
});

/** Run over a message whose body is exactly these bytes (a binary string:
 * a byte per character), the root a multipart with boundary "outer". */
function runRaw(script: string, body: string, rootCt = "multipart/mixed; boundary=outer") {
  const s = load(script, { enabledExtensions: ALL_EXTENSIONS });
  const headers = new Map([["content-type", [rootCt]], ["from", ["a@x"]]]);
  const bytes = Uint8Array.from(body, (c) => c.charCodeAt(0));
  const d = newRuntimeData(s, new DummyPolicy(), new EnvelopeStatic(), new MessageStatic(bytes.length, headers, bytes));
  s.execute(d);
  return d.mailboxes;
}
/** The nested multipart with this Content-Type parameter value, its parts
 * delimited by `delim` (the boundary core decodes from it), as bytes. */
const nested = (param: string, delim: string) =>
  `--outer\r\nContent-Type: multipart/mixed; boundary="${param}"\r\n\r\n` +
  `--${delim}\r\nContent-Type: text/plain\r\n\r\nhello\r\n--${delim}\r\n${exe}--${delim}--\r\n--outer--\r\n`;

describe("an encoded boundary is decoded as core decodes it", () => {
  const cases: [string, string, string][] = [
    // core keeps the whole raw value for a charset it does not know
    ["an unknown charset", "=?windows-1252?Q?abc?=", "=?windows-1252?Q?abc?="],
    ["a bogus charset", "=?bogus?Q?abc?=", "=?bogus?Q?abc?="],
    ["an RFC 2231 language suffix", "=?utf-8*en?Q?abc?=", "=?utf-8*en?Q?abc?="],
    ["utf-16", "=?utf-16?B?AGEAYg==?=", "=?utf-16?B?AGEAYg==?="],
    // and passes a malformed word through as written
    ["bad base64", "=?utf-8?B?YWJ?=", "=?utf-8?B?YWJ?="],
    ["bad hex in Q", "=?utf-8?Q?a=G1?=", "=?utf-8?Q?a=G1?="],
    // and keeps the bytes a word decodes to, invalid UTF-8 included
    ["an invalid UTF-8 byte", "=?utf-8?Q?a=FFb?=", "a\xffb"],
    ["a Latin-1 byte labelled UTF-8", "=?UTF-8?q?=e9?=", "\xe9"],
    ["a character split across two words", "=?utf-8?Q?=C3?= =?utf-8?Q?=A9?=", "\xc3\xa9"],
    ["raw 8-bit before a word", "\xc3\xa9=?utf-8?Q?x?=", "\xc3\xa9x"],
  ];
  for (const [name, param, delim] of cases) {
    it(name, () => {
      expect(runRaw(anychild, nested(param, delim))).toEqual(["Junk"]);
    });
  }
});

describe("header values as core reads them", () => {
  it("a root boundary given as text is matched as its UTF-8 bytes", () => {
    const m = `From: a@x\r\nContent-Type: multipart/mixed; boundary="é"\r\n\r\n--é\r\nContent-Type: text/plain\r\n\r\nhi\r\n--é\r\n${exe}--é--\r\n`;
    expect(run(anychild, m).fileinto).toEqual(["Junk"]);
    const body = 'require ["fileinto","body"]; if body :content "application/x-msdownload" :contains "MZ" { fileinto "Junk"; }';
    expect(run(body, m).fileinto).toEqual(["Junk"]);
  });

  it("a folded value keeps a vertical tab, as core trims only space and tab", () => {
    const body =
      `--outer\r\nContent-Type: multipart/mixed; boundary="a\r\n \x0bb"\r\n\r\n` +
      `--a \x0bb\r\nContent-Type: text/plain\r\n\r\nhello\r\n--a \x0bb\r\n${exe}--a \x0bb--\r\n--outer--\r\n`;
    expect(runRaw(anychild, body)).toEqual(["Junk"]);
  });
});
