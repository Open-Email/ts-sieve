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
import { ALL_EXTENSIONS, R, run } from "./harness.js";

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

// A part has one media type and one disposition: core's walker reads the
// first Content-Type and Content-Disposition (go-message's Header.Get), and
// the client shows that one. A :mime option that read every field matched a
// second type the client never shows (#72).

/** A multipart message whose second part carries these header lines. */
const withPart = (lines: string) =>
  `From: a@x\r\nTo: b@y\r\nContent-Type: multipart/mixed; boundary=b\r\n\r\n` +
  `--b\r\nContent-Type: text/plain\r\n\r\nhello\r\n--b\r\n${lines}\r\n\r\nMZ\r\n--b--\r\n`;
/** The review's dup-part-ct-rev: core shows the second part as text/plain. */
const twoTypes = withPart("Content-Type: text/plain\r\nContent-Type: application/x-msdownload");
const exeFirst = withPart("Content-Type: application/x-msdownload\r\nContent-Type: text/plain");
const rootTwoTypes = "From: a@x\r\nTo: b@y\r\nContent-Type: text/plain\r\nContent-Type: application/x-msdownload\r\n\r\nMZ\r\n";
/** `test` as the condition of a rule that files Junk. */
const junkIf = (test: string, extra: string[] = []) =>
  `require ${JSON.stringify(["fileinto", "mime", ...extra])}; if ${test} { fileinto "Junk"; }`;

describe("a MIME option reads a part's first Content-Type and Content-Disposition", () => {
  it("a second Content-Type is not the part's type", () => {
    expect(run(anychild, twoTypes).fileinto).toEqual([]);
    expect(run(junkIf('header :mime :anychild :subtype "content-type" "x-msdownload"'), twoTypes).fileinto).toEqual([]);
    expect(run(junkIf('header :mime :anychild :type "content-type" "application"'), twoTypes).fileinto).toEqual([]);
  });

  it("the body test reads the same field", () => {
    const body = (type: string) => junkIf(`body :content "${type}" :contains "MZ"`, ["body"]);
    expect(run(body("application/x-msdownload"), twoTypes).fileinto).toEqual([]);
    expect(run(body("text/plain"), twoTypes).fileinto).toEqual(["Junk"]);
  });

  it("at the root", () => {
    expect(run(junkIf('header :mime :contenttype "content-type" "application/x-msdownload"'), rootTwoTypes).fileinto).toEqual([]);
    expect(run(junkIf('header :mime :subtype "content-type" "x-msdownload"'), rootTwoTypes).fileinto).toEqual([]);
    expect(run(junkIf('header :mime :contenttype "content-type" "text/plain"'), rootTwoTypes).fileinto).toEqual(["Junk"]);
  });

  it("a second field's parameters are not read", () => {
    const ct = withPart('Content-Type: text/plain\r\nContent-Type: application/octet-stream; name="evil.exe"');
    expect(run(junkIf('header :mime :anychild :param "name" :matches "content-type" "*.exe"'), ct).fileinto).toEqual([]);
    const cd = withPart('Content-Type: application/octet-stream\r\nContent-Disposition: inline\r\nContent-Disposition: attachment; filename="evil.exe"');
    expect(run(junkIf('header :mime :anychild :param "filename" :matches "content-disposition" "*.exe"'), cd).fileinto).toEqual([]);
    expect(run(junkIf('header :mime :anychild :contenttype "content-disposition" "attachment"'), cd).fileinto).toEqual([]);
  });

  it("the first field is read", () => {
    expect(run(anychild, exeFirst).fileinto).toEqual(["Junk"]);
    expect(run(junkIf('header :mime :anychild :subtype "content-type" "x-msdownload"'), exeFirst).fileinto).toEqual(["Junk"]);
    const ct = withPart('Content-Type: application/octet-stream; name="evil.exe"\r\nContent-Type: text/plain');
    expect(run(junkIf('header :mime :anychild :param "name" :matches "content-type" "*.exe"'), ct).fileinto).toEqual(["Junk"]);
    const cd = withPart('Content-Type: application/octet-stream\r\nContent-Disposition: attachment; filename="evil.exe"\r\nContent-Disposition: inline');
    expect(run(junkIf('header :mime :anychild :param "filename" :matches "content-disposition" "*.exe"'), cd).fileinto).toEqual(["Junk"]);
    expect(run(junkIf('header :mime :anychild :contenttype "content-disposition" "attachment"'), cd).fileinto).toEqual(["Junk"]);
  });

  it("plain :mime reads every field", () => {
    expect(run(junkIf('header :mime :anychild "content-type" "application/x-msdownload"'), twoTypes).fileinto).toEqual(["Junk"]);
    expect(run(junkIf('header :mime "content-type" "application/x-msdownload"'), rootTwoTypes).fileinto).toEqual(["Junk"]);
  });

  it(":count counts one type a part, and every field without an option", () => {
    const count = (opt: string, n: number) =>
      junkIf(`header :mime :anychild :count "eq" :comparator "i;ascii-numeric" ${opt} "content-type" "${n}"`, ["relational", "comparator-i;ascii-numeric"]);
    // The root, the text part, and the part with two fields.
    expect(run(count(":contenttype", 3), twoTypes).fileinto).toEqual(["Junk"]);
    expect(run(count("", 4), twoTypes).fileinto).toEqual(["Junk"]);
  });

  it("over a cut body, a second field does not decide a miss", () => {
    // The part with two fields is whole; parts may follow it past the cut.
    const cut = twoTypes.slice(0, twoTypes.indexOf("--b--"));
    const exe = junkIf('header :mime :anychild :subtype "content-type" "x-msdownload"');
    expect(run(exe, cut, { bodyTruncated: true })).toEqual(R({ implicitKeep: true, indeterminate: true }));
    const clean = 'require ["fileinto","mime"]; if not header :mime :anychild :subtype "content-type" "x-msdownload" { fileinto "Clean"; }';
    expect(run(clean, cut, { bodyTruncated: true })).toEqual(R({ implicitKeep: true, indeterminate: true }));
    expect(run(clean, twoTypes)).toEqual(R({ fileinto: ["Clean"] }));
  });

  it("at the root, the first as the script's edits left it", () => {
    // RFC 5293: a test reads the header as edited.
    const edited = (edit: string) =>
      `require ["fileinto","mime","editheader"]; ${edit}; if header :mime :contenttype "content-type" "application/x-msdownload" { fileinto "Junk"; }`;
    expect(run(edited('deleteheader :index 1 "content-type"'), rootTwoTypes).fileinto).toEqual(["Junk"]);
    const root = "From: a@x\r\nTo: b@y\r\nContent-Type: text/plain\r\n\r\nMZ\r\n";
    expect(run(edited('addheader :last "Content-Type" "application/x-msdownload"'), root).fileinto).toEqual([]);
    expect(run(edited('addheader "Content-Type" "application/x-msdownload"'), root).fileinto).toEqual(["Junk"]);
  });

  it("a first field in doubt is not passed over for the second", () => {
    // The added field, prepended, holds a prefix of a long Subject: its type is
    // unknown, and the received text/plain after it is not the root's type.
    const script =
      'require ["variables","editheader","mime","fileinto"]; if header :matches "subject" "*" { set "s" "${1}"; } ' +
      'addheader "Content-Type" "${s}"; if header :mime :contenttype "content-type" "text/plain" { fileinto "Text"; }';
    const m = `From: a@x\r\nSubject: ${"x".repeat(4500)}\r\nContent-Type: text/plain\r\n\r\nbody\r\n`;
    expect(run(script, m, { options: { maxMatchInputLength: 16 * 1024 } })).toMatchObject({ fileinto: [], indeterminate: true });
  });
});

describe(":index under :mime counts a part's own fields", () => {
  const indexed = (tags: string, value: string) => junkIf(`header :mime :anychild ${tags} :contenttype "content-type" "${value}"`, ["index"]);

  it("an explicit :index is not overridden by the first-field rule", () => {
    expect(run(indexed(":index 2", "application/x-msdownload"), twoTypes).fileinto).toEqual(["Junk"]);
    expect(run(indexed(":index 1 :last", "application/x-msdownload"), twoTypes).fileinto).toEqual(["Junk"]);
    expect(run(indexed(":index 1", "application/x-msdownload"), twoTypes).fileinto).toEqual([]);
  });

  it("in each part, not across the parts in scope", () => {
    // Across them, the second field would be the first part's text/plain.
    expect(run(indexed(":index 2", "text/plain"), twoTypes).fileinto).toEqual([]);
    expect(run(indexed(":index 3 :matches", "*"), twoTypes).fileinto).toEqual([]);
  });

  it("plain :mime honours it", () => {
    const m = "From: a@x\r\nTo: b@y\r\nSubject: a\r\nSubject: b\r\n\r\nbody\r\n";
    expect(run(junkIf('header :mime :index 1 "subject" "b"', ["index"]), m).fileinto).toEqual([]);
    expect(run(junkIf('header :mime :index 2 "subject" "b"', ["index"]), m).fileinto).toEqual(["Junk"]);
  });
});
