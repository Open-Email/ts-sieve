// A multipart's part list read as core reads it.
//
// Core's MIME walker (src/lib/mimewalk/multipart.ts, a port of go-message's
// fork of Go's mime/multipart) is what the user's mail client is served, and
// it ENDS a multipart's part list where the engine's splitter read on: at a
// part whose header block its header reader refuses, at a line after a part
// that is not a delimiter line ("--b junk", "--b-alt", "--b--junk"), at a
// delimiter line in the other line-ending mode, and at a line longer than its
// 4096-byte buffer. A part past that point is one the client does not show,
// so a rule must not act on it: a hidden .exe could drive a message into Junk,
// or into a discard. A multipart with no parts gets one text/plain child, and
// an embedded message's header ends at a line the reader refuses; a rule must
// see both as the client does. Issue #58.

import { describe, expect, it } from "vitest";
import { DummyPolicy, EnvelopeStatic, load, MessageStatic, newRuntimeData } from "../src/index.js";
import { ALL_EXTENSIONS, R, type Result } from "./harness.js";

const exe = 'Content-Type: application/x-msdownload\r\nContent-Disposition: attachment; filename="evil.exe"\r\n\r\nMZ\r\n';
const text = "Content-Type: text/plain\r\n\r\nhello\r\n";
const E9 = String.fromCharCode(0xe9);

const anychild = 'require ["fileinto","mime"]; if header :mime :anychild :contenttype "content-type" "application/x-msdownload" { fileinto "Junk"; }';
const loop = 'require ["mime","foreverypart"]; foreverypart { if header :mime :param "filename" :matches "content-disposition" "*.exe" { discard; stop; } }';
const bodyExe = 'require ["fileinto","body"]; if body :content "application/x-msdownload" :contains "MZ" { fileinto "Junk"; }';

/** Run over a message whose body is exactly these bytes (a binary string: a
 * byte per character), its root Content-Type `rootCt`. */
function runRaw(script: string, body: string, opts: { rootCt?: string; cut?: boolean } = {}): Result {
  const s = load(script, { enabledExtensions: ALL_EXTENSIONS });
  const headers = new Map([["content-type", [opts.rootCt ?? "multipart/mixed; boundary=b"]], ["from", ["a@x"]]]);
  const bytes = Uint8Array.from(body, (c) => c.charCodeAt(0));
  const d = newRuntimeData(s, new DummyPolicy(), new EnvelopeStatic(), new MessageStatic(bytes.length, headers, bytes, opts.cut ?? false));
  s.execute(d);
  return { redirect: d.redirectAddr, fileinto: d.mailboxes, keep: d.keep, implicitKeep: d.implicitKeep, flags: d.flags, indeterminate: d.indeterminate };
}

/** Whether each kind of rule sees the exe part: :mime :anychild, a
 * foreverypart filename rule, and the body test. Each answer is definite. */
function seesExe(body: string, rootCt?: string): { mime: boolean; loop: boolean; body: boolean } {
  const a = runRaw(anychild, body, { rootCt });
  const l = runRaw(loop, body, { rootCt });
  const b = runRaw(bodyExe, body, { rootCt });
  for (const r of [a, l, b]) expect(r.indeterminate).toBe(false);
  return { mime: a.fileinto.includes("Junk"), loop: !l.keep && !l.implicitKeep, body: b.fileinto.includes("Junk") };
}
const SEEN = { mime: true, loop: true, body: true };
const UNSEEN = { mime: false, loop: false, body: false };

/** What `if <test> { fileinto "Y"; }` does: YES, NO or UNKNOWN below. */
function bodyTest(test: string, body: string, opts: { rootCt?: string; cut?: boolean } = {}): Result {
  return runRaw(`require ["body","fileinto","relational","comparator-i;ascii-numeric"]; if ${test} { fileinto "Y"; }`, body, opts);
}
const YES = R({ fileinto: ["Y"] });
const NO = R({ implicitKeep: true });
const UNKNOWN = R({ implicitKeep: true, indeterminate: true });

describe("a part whose header block core's reader refuses ends the list", () => {
  /** The text part, then a part whose header block starts with `bad` and goes
   * on as the exe part's, then a clean exe part. */
  const afterBad = (bad: string) => `--b\r\n${text}--b\r\n${bad}${exe}--b\r\n${exe}--b--\r\n`;
  const shapes: [string, string][] = [
    // The three from the review of core #243.
    ["a junk line (no colon)", "JUNKLINE\r\n"],
    ["a leading-folded first line", " x\r\n"],
    ["an 8-bit byte in a field name", `X-${E9}: y\r\n`],
    // And the rest of the reader's refusals.
    ["a junk line after a good field", "X-Ok: 1\r\nJUNKLINE\r\n"],
    ["a space inside a field name", "X Bad: y\r\n"],
    ["a control byte in a field name", `X-${String.fromCharCode(1)}: y\r\n`],
    ["a CR-only line where the blank line would be", "\r\r\n"],
    ["a field over the 1 MiB part-header budget", `X-Big: ${"a".repeat(700_000)}\r\n`],
  ];
  for (const [name, bad] of shapes) {
    it(name, () => {
      expect(seesExe(afterBad(bad))).toEqual(UNSEEN);
      // The part before it is still seen.
      expect(bodyTest('body :content "text/plain" :is "hello"', afterBad(bad))).toEqual(YES);
    });
  }

  it("the control: a clean part header", () => {
    expect(seesExe(afterBad("X-Ok: 1\r\n"))).toEqual(SEEN);
  });

  it("the budget, to the byte", () => {
    // Core's port charges each line its pieces and 2 more, each field its
    // length and its buffer slack (half its length and 256 past 256 bytes),
    // and the end of the input 2. A field of at most 256 bytes costs 256.
    // Here the folded line ends the body on a 4096-byte piece: its line
    // break is not in the field, and the slack is a byte less.
    const shape = (n: number, tail = "") =>
      `--b\r\nContent-Type: application/x-msdownload\r\nX-A: ${"a".repeat(n)}\r\n ${"a".repeat(4096 * 170 - 1)}${tail}`;
    expect(runRaw(anychild, shape(2380))).toEqual(R({ fileinto: ["Junk"] }));
    expect(runRaw(anychild, shape(2381))).toEqual(R({ implicitKeep: true }));
    expect(runRaw(anychild, shape(2380, "\r\n"))).toEqual(R({ implicitKeep: true }));
  });

  it("a field just inside the budget is kept", () => {
    expect(seesExe(afterBad(`X-Big: ${"a".repeat(690_000)}\r\n`))).toEqual(SEEN);
  });

  it("a header block that runs into the close delimiter, with no blank line", () => {
    const body = `--b\r\n${text}--b\r\nContent-Type: application/x-msdownload\r\n--b--\r\n`;
    expect(runRaw(anychild, body)).toEqual(R({ implicitKeep: true }));
  });

  it("a header block that runs to the end of the body is a part: the reader stops at the end without an error", () => {
    const body = `--b\r\n${text}--b\r\nContent-Type: application/x-msdownload`;
    expect(runRaw(anychild, body)).toEqual(R({ fileinto: ["Junk"] }));
    expect(runRaw(anychild, `${body}\r\n`)).toEqual(R({ fileinto: ["Junk"] }));
  });

  it("in a nested multipart, only if the part holding it ended at a boundary", () => {
    // A part that runs out with no boundary reads to an unexpected end of
    // input (Go's io.ErrUnexpectedEOF), and a header block that meets that
    // end is refused.
    const nested = `--b\r\nContent-Type: multipart/mixed; boundary=c\r\n\r\n--c\r\n${text}--c\r\nContent-Type: application/x-msdownload`;
    expect(runRaw(anychild, `${nested}\r\n--b--\r\n`)).toEqual(R({ fileinto: ["Junk"] }));
    expect(runRaw(anychild, `${nested}\r\n`)).toEqual(R({ implicitKeep: true }));
    expect(runRaw(anychild, nested)).toEqual(R({ implicitKeep: true }));
    expect(bodyTest('body :content "text/plain" :is "hello"', nested)).toEqual(YES);
  });
});

describe("a line after a part that is not a delimiter line ends the list", () => {
  /** The text part, then `line` where its delimiter would be, then two exe parts. */
  const after = (line: string) => `--b\r\n${text}${line}\r\n${exe}--b\r\n${exe}--b--\r\n`;
  for (const [name, line] of [
    ['"--b junk"', "--b junk"],
    ['"--b" and a tab, then text', "--b\tjunk"],
    ['"--b-x": a "-" after the boundary ends the part', "--b-x"],
    ['text after the close: "--b--junk"', "--b--junk"],
    ['padding and text after the close: "--b-- x"', "--b-- x"],
  ] as const) {
    it(name, () => {
      expect(seesExe(after(line))).toEqual(UNSEEN);
      // The text part ends at that line.
      expect(bodyTest('body :content "text/plain" :is "hello"', after(line))).toEqual(YES);
    });
  }

  it("the control: a delimiter with transport padding continues it", () => {
    expect(seesExe(after("--b \t"))).toEqual(SEEN);
  });

  it("a close delimiter ends it, whatever follows", () => {
    expect(seesExe(`--b\r\n${text}--b--\r\n--b\r\n${exe}--b--\r\n`)).toEqual(UNSEEN);
  });

  it("a line that only starts with the boundary is the part's content", () => {
    const body = `--b\r\n${text}--bx\r\nmore\r\n--b\r\n${exe}--b--\r\n`;
    expect(seesExe(body)).toEqual(SEEN);
    expect(bodyTest('body :content "text/plain" :contains "more"', body)).toEqual(YES);
  });

  it("a part with an empty body: the delimiter right after its header block", () => {
    const body = `--b\r\nContent-Type: text/plain\r\n\r\n--b\r\n${exe}--b--\r\n`;
    expect(seesExe(body)).toEqual(SEEN);
    const junk = `--b\r\nContent-Type: text/plain\r\n\r\n--b junk\r\n${exe}--b--\r\n`;
    expect(seesExe(junk)).toEqual(UNSEEN);
    // The list ends at that line, though a delimiter line follows it.
    const thenDelimiter = `--b\r\nContent-Type: text/plain\r\n\r\n--b junk\r\n--b\r\n${exe}--b--\r\n`;
    expect(seesExe(thenDelimiter)).toEqual(UNSEEN);
  });

  it("a last part with no close delimiter: a tail that could begin one is not its content", () => {
    expect(bodyTest('body :content "text/plain" :is "hello"', `--b\r\n${text}`)).toEqual(YES);
    expect(bodyTest('body :content "text/plain" :is "hello"', `--b\r\n${text}--`)).toEqual(YES);
  });
});

describe("a nested boundary the outer one prefixes", () => {
  // "--b-alt" ends a part of the outer "b" multipart (a "-" follows the
  // boundary), so the nested multipart's body is empty, its one child is the
  // synthesized empty text/plain, and the outer list ends there.
  const alt =
    '--b\r\nContent-Type: multipart/alternative; boundary="b-alt"\r\n\r\n' +
    `--b-alt\r\nContent-Type: text/plain\r\n\r\nplain\r\n--b-alt--\r\n--b\r\n${exe}--b--\r\n`;

  it("the parts after it are not seen", () => {
    expect(seesExe(alt)).toEqual(UNSEEN);
  });

  it("the nested text is not seen, the synthesized empty text/plain is", () => {
    expect(bodyTest('body :content "text/plain" :contains "plain"', alt)).toEqual(NO);
    expect(bodyTest('body :content "text/plain" :is ""', alt)).toEqual(YES);
    expect(bodyTest('body :content "text/plain" :count "eq" "1"', alt)).toEqual(YES);
  });

  it("an earlier part is still seen", () => {
    const body = `--b\r\n${exe}${alt}`;
    expect(seesExe(body)).toEqual(SEEN);
  });
});

describe("line endings: the first delimiter line sets them for the whole multipart", () => {
  const exeLF = exe.replaceAll("\r\n", "\n");

  it("bare LF throughout is read", () => {
    const body = `--b\nContent-Type: text/plain\n\nhello\n--b\n${exeLF}--b--\n`;
    expect(seesExe(body)).toEqual(SEEN);
  });

  it("transport padding before the LF of the first delimiter line still sets LF", () => {
    const body = `--b \t\nContent-Type: text/plain\n\nhello\n--b\n${exeLF}--b--\n`;
    expect(seesExe(body)).toEqual(SEEN);
  });

  it("LF mode: a later CRLF delimiter line ends the list", () => {
    const body = `--b\nContent-Type: text/plain\n\nhello\r\n--b\r\n${exe}--b--\r\n`;
    expect(seesExe(body)).toEqual(UNSEEN);
  });

  it("LF mode: the CR before a delimiter's LF stays in the part", () => {
    const body = "--b\nContent-Type: text/plain\n\nexact\r\n--b--\n";
    expect(bodyTest('body :content "text/plain" :is "exact"', body)).toEqual(NO);
    expect(bodyTest('body :content "text/plain" :matches "exact?"', body)).toEqual(YES);
  });

  it("CRLF mode: a bare-LF line before the boundary is the part's content", () => {
    const body = `--b\r\nContent-Type: text/plain\r\n\r\nhello\n--b\r\n${exe}--b--\r\n`;
    expect(seesExe(body)).toEqual(UNSEEN);
    expect(bodyTest('body :content "text/plain" :contains "MZ"', body)).toEqual(YES);
  });

  it("CRLF mode: a later LF-terminated delimiter line ends the list", () => {
    const body = `--b\r\n${text}--b\n${exe}--b\r\n${exe}--b--\r\n`;
    expect(seesExe(body)).toEqual(UNSEEN);
  });

  it("CRLF mode: a part's header block may still end its lines with LF", () => {
    const body = `--b\r\nContent-Type: text/plain\n\nhello\r\n--b\r\n${exe}--b--\r\n`;
    expect(seesExe(body)).toEqual(SEEN);
  });
});

describe("a multipart with no parts has one synthesized text/plain child", () => {
  const twoParts = `--b\r\n${text}--b\r\n${exe}--b--\r\n`;
  const iterations =
    'require ["foreverypart","variables","fileinto"]; set "n" ""; foreverypart { set "n" "${n}x"; } if string :is "${n}" "xx" { fileinto "Two"; }';

  for (const rootCt of ["multipart/mixed", 'multipart/mixed; boundary=""'] as const) {
    it(`no boundary (${rootCt}): the child is the whole body`, () => {
      expect(seesExe(twoParts, rootCt)).toEqual(UNSEEN);
      expect(bodyTest('body :content "text/plain" :contains "MZ"', twoParts, { rootCt })).toEqual(YES);
      expect(bodyTest('body :text :contains "hello"', twoParts, { rootCt })).toEqual(YES);
      expect(runRaw(iterations, twoParts, { rootCt }).fileinto).toEqual(["Two"]);
    });
  }

  it("extracttext reads the synthesized child", () => {
    const script =
      'require ["foreverypart","mime","extracttext","variables","fileinto"]; foreverypart { extracttext "t"; if string :contains "${t}" "MZ" { fileinto "Seen"; } }';
    expect(runRaw(script, twoParts, { rootCt: "multipart/mixed" }).fileinto).toEqual(["Seen"]);
  });

  it("no delimiter line at all: the walker read the whole body, the child is empty", () => {
    const rootCt = "multipart/mixed; boundary=zz";
    expect(bodyTest('body :content "text/plain" :is ""', twoParts, { rootCt })).toEqual(YES);
    expect(bodyTest('body :text :contains "hello"', twoParts, { rootCt })).toEqual(NO);
    expect(runRaw(iterations, twoParts, { rootCt }).fileinto).toEqual(["Two"]);
  });

  it("a close delimiter before any part, at the end of the body: empty", () => {
    expect(bodyTest('body :content "text/plain" :is ""', "preamble\r\n--b--\r\n")).toEqual(YES);
  });

  it("a nested multipart with no parts has the child too", () => {
    const body = `--b\r\nContent-Type: multipart/alternative; boundary=c\r\n\r\nnothing here\r\n--b\r\n${exe}--b--\r\n`;
    expect(seesExe(body)).toEqual(SEEN);
    expect(bodyTest('body :content "text/plain" :is ""', body)).toEqual(YES);
  });

  it("a preamble line longer than the walker's 4096-byte buffer: the child is what the walker had not buffered", () => {
    // The walker's buffered reader gives up on the line once 4096 bytes hold
    // no line break, and the child is the body after those 4096 bytes.
    const body = `${"p".repeat(5000)}\r\n--b\r\n${text}--b\r\n${exe}--b--\r\n`;
    expect(seesExe(body)).toEqual(UNSEEN);
    expect(bodyTest(`body :content "text/plain" :matches "${"p".repeat(904)}*"`, body)).toEqual(YES);
    expect(bodyTest(`body :content "text/plain" :matches "${"p".repeat(905)}*"`, body)).toEqual(NO);
    expect(bodyTest('body :content "text/plain" :contains "MZ"', body)).toEqual(YES);
    // The multipart's own text keeps what the walker read of that line, as
    // when the cut falls inside it.
    expect(bodyTest('body :content "multipart" :contains "pppp"', body)).toEqual(YES);
    expect(bodyTest('body :content "multipart" :is ""', body)).toEqual(NO);
  });

  it("a preamble line that just fits the buffer is skipped", () => {
    const body = `${"p".repeat(4094)}\r\n--b\r\n${text}--b\r\n${exe}--b--\r\n`;
    expect(seesExe(body)).toEqual(SEEN);
  });

  it("when what core's child holds depends on its reader's buffering, the child's text is unknown", () => {
    // The first part's header is refused. Core's child is whatever its reader
    // had not yet buffered, which depends on the size of the message's own
    // header too: a miss over it is not proven, but the part is there.
    const body = `--b\r\nJUNKLINE\r\n\r\nx\r\n--b\r\n${exe}--b--\r\n`;
    expect(seesExe(body)).toEqual(UNSEEN);
    expect(bodyTest('body :content "text/plain" :is ""', body)).toEqual(UNKNOWN);
    expect(bodyTest('body :content "text/plain" :count "eq" "1"', body)).toEqual(YES);
    // A close delimiter with an epilogue after it, the same.
    expect(bodyTest('body :content "text/plain" :is ""', "preamble\r\n--b--\r\nepilogue\r\n")).toEqual(UNKNOWN);
  });
});

describe("an embedded message's header block is read as core reads it", () => {
  it("a CR-only line ends its fields; its body starts after that line", () => {
    // core #258: the line is malformed, which core ignores in an embedded
    // message, so the multipart's preamble and parts are not header lines.
    const body =
      "--b\r\nContent-Type: message/rfc822\r\n\r\n" +
      `From: x@y\r\nContent-Type: multipart/mixed; boundary=c\r\n\r\r\npre\r\n--c\r\n${exe}--c--\r\n--b--\r\n`;
    expect(seesExe(body)).toEqual(SEEN);
  });

  it("a leading-folded first line: no fields, its body starts after that line", () => {
    const body = `--b\r\nContent-Type: message/rfc822\r\n\r\n From: x@y\r\n${exe}--b--\r\n`;
    expect(seesExe(body)).toEqual(UNSEEN);
    expect(bodyTest('body :content "text/plain" :contains "x-msdownload"', body)).toEqual(YES);
  });

  it("an 8-bit byte in a field name: the fields before it, the body after it", () => {
    const body = `--b\r\nContent-Type: message/rfc822\r\n\r\nFrom: x@y\r\nX-${E9}: z\r\n${exe}--b--\r\n`;
    expect(seesExe(body)).toEqual(UNSEEN);
  });
});

/** `prefix`, then "a" up to `len` bytes, with each [offset, text] mark
 * written at that offset. */
function filled(prefix: string, len: number, marks: [number, string][] = []): string {
  const chars = (prefix + "a".repeat(len - prefix.length)).split("");
  for (const [at, t] of marks) for (let i = 0; i < t.length; i++) chars[at + i] = t[i]!;
  return chars.join("");
}

describe("a first part whose header runs over the budget: where core's reader stopped", () => {
  // Core's reader charges a long line by the 4096-byte pieces Go's ReadLine
  // returns, and stops at the piece that runs the budget out: with its buffer
  // full, it has read exactly to that piece's end, and the synthesized child
  // is the rest of the body.
  // "X-A: a…" from offset 5: 257 pieces of 4096 run out 1 MiB, so the child
  // starts at 5 + 257 × 4096.
  const at = 5 + 257 * 4096;
  const marks: [number, string][] = [
    [at - 100, "EARLY"],
    [at, "START"],
    [at + 50_000, "LATE"],
  ];
  const child = (body: string, test: string) => bodyTest(`body :content "text/plain" ${test}`, body);
  const exact = (body: string) => {
    expect(child(body, ':matches "START*"')).toEqual(YES);
    expect(child(body, ':contains "LATE"')).toEqual(YES);
    expect(child(body, ':contains "EARLY"')).toEqual(NO);
  };

  it("a field line that runs out the budget", () => {
    const body = filled("--b\r\nX-A: ", 1_250_000, marks);
    exact(body);
    exact(`${body}\r\n`);
    expect(runRaw(anychild, body)).toEqual(R({ implicitKeep: true }));
  });

  it("a folded first line that runs out the budget", () => {
    exact(filled("--b\r\n X: ", 1_250_000, marks));
  });

  it("a continuation line that runs out the budget", () => {
    // The first line costs 8, so 256 pieces of the second run it out.
    const at2 = 13 + 256 * 4096;
    const body = filled("--b\r\nX-A: 1\r\n X: ", 1_250_000, [[at2 - 100, "EARLY"], [at2, "START"], [at2 + 50_000, "LATE"]]);
    exact(body);
  });

  it("a CR at a piece's end is read again with the next piece", () => {
    // The first piece ends in CR: Go puts it back, the piece is 4095 bytes,
    // and every later piece starts a byte earlier.
    const body = filled("--b\r\nX-A: ", 1_250_000, [[5 + 4095, "\r"], [at - 1, "START"]]);
    expect(child(body, ':matches "START*"')).toEqual(YES);
  });

  it("a CR at the end of the piece that runs the budget out is read, but the piece was buffered whole", () => {
    const body = filled("--b\r\nX-A: ", 1_250_000, [[at - 1, "\r"], [at, "START"]]);
    expect(child(body, ':matches "START*"')).toEqual(YES);
  });

  it("short lines that run the budget out on the body's last line: the reader read everything", () => {
    // "X-Pad: 1" costs 10, each folded line 73: the 14364th runs it out.
    let body = "--b\r\nX-Pad: 1\r\n";
    for (let i = 0; i < 14364; i++) body += ` ${"a".repeat(70)}\r\n`;
    expect(bodyTest('body :content "text/plain" :is ""', body)).toEqual(YES);
  });

  it("short lines: where the reader stopped hangs on its buffering, so the child's text is unknown", () => {
    let body = "--b\r\nX-Pad: 1\r\n";
    while (body.length < 1_150_000) body += ` ${"a".repeat(70)}\r\n`;
    body += " Buy cheap pills now\r\n";
    expect(bodyTest('body :text :contains "pills"', body)).toEqual(UNKNOWN);
    expect(bodyTest('body :content "text/plain" :is ""', body)).toEqual(UNKNOWN);
    expect(bodyTest('body :content "text/plain" :count "eq" "1"', body)).toEqual(YES);
  });
});

describe("a field's first line that ends on a 4096-byte piece at the end of the body", () => {
  // Go's ReadLine then reads one more, empty, piece and returns io.EOF with
  // it, which go-message's reader takes as an error on a field's first line.
  const head = `--b\r\n${text}--b\r\nContent-Type: application/x-msdownload\r\n`;
  const pad = (n: number) => `X-Pad: ${"a".repeat(n - 7)}`;

  it("refuses the part", () => {
    expect(runRaw(anychild, head + pad(4096))).toEqual(R({ implicitKeep: true }));
    expect(bodyTest('body :content "application/x-msdownload" :count "ge" "1"', head + pad(4096))).toEqual(NO);
    expect(runRaw(anychild, head + pad(8192))).toEqual(R({ implicitKeep: true }));
  });

  it("but not a line of another length, one ending in a line break, or a continuation line", () => {
    expect(runRaw(anychild, head + pad(4095))).toEqual(R({ fileinto: ["Junk"] }));
    expect(runRaw(anychild, head + pad(4097))).toEqual(R({ fileinto: ["Junk"] }));
    expect(runRaw(anychild, `${head + pad(4096)}\r\n`)).toEqual(R({ fileinto: ["Junk"] }));
    expect(runRaw(anychild, `${head}X-A: 1\r\n ${"a".repeat(4095)}`)).toEqual(R({ fileinto: ["Junk"] }));
    // A CR at the end of the first piece is read again: the line ends inside
    // a second piece.
    expect(runRaw(anychild, `${head + pad(4095)}\r`)).toEqual(R({ fileinto: ["Junk"] }));
  });
});

describe("a boundary whose line break and dashes fill the walker's 4096-byte buffer", () => {
  // Then the walker cannot see the byte after "\r\n--" boundary, and takes
  // any byte there as ending the part.
  const shape = (len: number, nl: string) => {
    const q = "q".repeat(len);
    const body =
      `--${q}${nl}Content-Type: text/plain${nl}${nl}hello${nl}--${q}X more${nl}` +
      `--${q}${nl}Content-Type: application/x-msdownload${nl}${nl}MZ${nl}--${q}--${nl}`;
    return { body, rootCt: `multipart/mixed; boundary="${q}"`, cutAt: body.indexOf(`${nl}--${q}X`) + nl.length + 2 + len };
  };

  for (const [len, nl] of [
    [4092, "\r\n"],
    [4093, "\n"],
  ] as const) {
    it(`${len} bytes with ${nl === "\n" ? "LF" : "CRLF"}: the part ends there, and the list with it`, () => {
      const { body, rootCt, cutAt } = shape(len, nl);
      expect(runRaw(anychild, body, { rootCt })).toEqual(R({ implicitKeep: true }));
      expect(bodyTest('body :content "text/plain" :is "hello"', body, { rootCt })).toEqual(YES);
      // Over a cut right after the boundary, that is decided already.
      expect(bodyTest('body :content "text/plain" :is "hello"', body.slice(0, cutAt), { rootCt, cut: true })).toEqual(YES);
    });
  }

  it("one byte shorter, the byte after it is read", () => {
    const { body, rootCt, cutAt } = shape(4091, "\r\n");
    expect(runRaw(anychild, body, { rootCt })).toEqual(R({ fileinto: ["Junk"] }));
    expect(bodyTest('body :content "text/plain" :contains "X more"', body, { rootCt })).toEqual(YES);
    expect(bodyTest('body :content "text/plain" :is "hello"', body.slice(0, cutAt), { rootCt, cut: true })).toEqual(UNKNOWN);
  });
});

describe("a multipart in a part that ended at a boundary: its end of input reaches core through the part", () => {
  // Core reads such a multipart through the outer part's reader, which hands
  // over its last bytes with the end of input or after them, as its own
  // 4096-byte window falls, which the size of the message's header moves.
  // Where Go's ReadLine sees a last piece of a full 4096 bytes, that decides
  // whether it reads one more, empty, piece, so what turns on it is unknown.
  const nest = (inner: string) => `--b\r\nContent-Type: multipart/mixed; boundary=c\r\n\r\n--c\r\n${inner}\r\n--b--\r\n`;
  const eofLine = (n: number) => `Content-Type: application/x-msdownload\r\nX-Pad: ${"p".repeat(n - 7)}`;
  const UNKNOWN_HIT = R({ implicitKeep: true, indeterminate: true });
  /** The body test's count of exe parts, at least one. */
  const exeCount = (body: string, rootCt?: string) =>
    bodyTest('body :content "application/x-msdownload" :count "ge" "1"', body, { rootCt });

  it("a field's first line ending on a 4096-byte piece is unknown, not refused", () => {
    expect(runRaw(anychild, nest(eofLine(4096)))).toEqual(UNKNOWN_HIT);
    expect(exeCount(nest(eofLine(4096)))).toEqual(UNKNOWN);
    expect(runRaw(anychild, nest(eofLine(8192)))).toEqual(UNKNOWN_HIT);
    // Two levels of parts.
    const two = `--a\r\nContent-Type: multipart/mixed; boundary=b\r\n\r\n${nest(eofLine(4096))}\r\n--a--\r\n`;
    expect(runRaw(anychild, two, { rootCt: "multipart/mixed; boundary=a" })).toEqual(UNKNOWN_HIT);
    // Another length is kept, as anywhere.
    expect(runRaw(anychild, nest(eofLine(4095)))).toEqual(R({ fileinto: ["Junk"] }));
  });

  it("where core reads it from a copy of the bytes, or a part that ran out, it is refused", () => {
    const inner = `--c\r\n${eofLine(4096)}`;
    const rfc822 = `From: x@y\r\nContent-Type: multipart/mixed; boundary=c\r\n\r\n${inner}`;
    expect(runRaw(anychild, rfc822, { rootCt: "message/rfc822" })).toEqual(R({ implicitKeep: true }));
    expect(exeCount(rfc822, "message/rfc822")).toEqual(NO);
    const message = `--b\r\nContent-Type: message/rfc822\r\n\r\nContent-Type: multipart/mixed; boundary=c\r\n\r\n${inner}\r\n--b--\r\n`;
    expect(runRaw(anychild, message)).toEqual(R({ implicitKeep: true }));
    expect(exeCount(message)).toEqual(NO);
    const ranOut = `--b\r\nContent-Type: multipart/mixed; boundary=c\r\n\r\n${inner}`;
    expect(runRaw(anychild, ranOut)).toEqual(R({ implicitKeep: true }));
    expect(exeCount(ranOut)).toEqual(NO);
  });

  it("a folded line ending on a 4096-byte piece: its line break counts toward the budget, or not", () => {
    // The budget edge from "the budget, to the byte": core keeps 2380 at the
    // top level; through a part the slack may be a byte more.
    const edge = (n: number) =>
      nest(`Content-Type: application/x-msdownload\r\nX-A: ${"a".repeat(n)}\r\n ${"a".repeat(4096 * 170 - 1)}`);
    expect(runRaw(anychild, edge(2379))).toEqual(R({ fileinto: ["Junk"] }));
    expect(runRaw(anychild, edge(2380))).toEqual(UNKNOWN_HIT);
    expect(exeCount(edge(2380))).toEqual(UNKNOWN);
    expect(runRaw(anychild, edge(2381))).toEqual(R({ implicitKeep: true }));
  });

  it("a loop that goes on past that list may have missed an iteration, even one that breaks or stops", () => {
    // The list left open is the first outer part's: the outer list goes on.
    // In core the exe part comes before the text part, so a loop that
    // reaches the text part has gone past where it would have run.
    const body = `--b\r\nContent-Type: multipart/mixed; boundary=c\r\n\r\n--c\r\n${eofLine(4096)}\r\n--b\r\n${text}--b--\r\n`;
    const loop = (then: string) =>
      `require ["foreverypart","mime","fileinto"]; foreverypart { if header :mime :type "content-type" "text" { fileinto "T"; ${then} } }`;
    expect(runRaw(loop("break;"), body)).toEqual(R({ fileinto: ["T"], indeterminate: true }));
    expect(runRaw(loop("stop;"), body)).toEqual(R({ fileinto: ["T"], indeterminate: true }));
    // One that breaks before it, or at the part whose list it is, did not.
    const at = (test: string) => `require ["foreverypart","mime","fileinto"]; foreverypart { if ${test} { fileinto "X"; break; } }`;
    expect(runRaw(at('header :mime :subtype "content-type" "mixed"'), body)).toEqual(R({ fileinto: ["X"] }));
    expect(runRaw(at('header :mime :param "boundary" "content-type" "c"'), body)).toEqual(R({ fileinto: ["X"] }));
    // Nor one that breaks on a part the open list does hold, before the gap.
    const held = `--b\r\nContent-Type: multipart/mixed; boundary=c\r\n\r\n--c\r\n${text}--c\r\n${eofLine(4096)}\r\n--b\r\n${text}--b--\r\n`;
    expect(runRaw(loop("break;"), held)).toEqual(R({ fileinto: ["T"] }));
  });
});

describe("a loop past a multipart deeper than the depth cap", () => {
  it("may have missed the iterations of the parts it did not walk", () => {
    // 101 nested multiparts in the first part, then a text part.
    let deep = "";
    for (let i = 1; i <= 101; i++) deep += `--d${i - 1}\r\nContent-Type: multipart/mixed; boundary=d${i}\r\n\r\n`;
    deep += `--d101\r\n${exe}`;
    for (let i = 101; i >= 0; i--) deep += `--d${i}--\r\n`;
    const body = `--b\r\nContent-Type: multipart/mixed; boundary=d0\r\n\r\n${deep}--b\r\n${text}--b--\r\n`;
    const script = 'require ["foreverypart","mime","fileinto"]; foreverypart { if header :mime :type "content-type" "text" { fileinto "T"; break; } }';
    expect(runRaw(script, body)).toEqual(R({ fileinto: ["T"], indeterminate: true }));
  });
});

describe("the part cap", () => {
  // The walkers stop at 1024 parts, and so does the splitter: a message of
  // many tiny parts costs no more than its first 1025, per body test.
  const many = `pre\r\n--b\r\n${text}${"--b\r\n\r\n".repeat(1100)}--b--\r\nzz\r\n`;

  it("past it the list, and the epilogue after it, are unseen", () => {
    expect(bodyTest('body :content "multipart" :contains "zz"', many)).toEqual(UNKNOWN);
    expect(bodyTest('body :content "multipart" :is ""', many)).toEqual(UNKNOWN);
    expect(bodyTest('body :content "text/plain" :contains "hello"', many)).toEqual(YES);
  });
});

describe("over a cut body, what the cut decides", () => {
  const cut = { cut: true };

  it("a refused part header before the cut ends the list: a miss is definite", () => {
    const body = `--b\r\n${text}--b\r\nJUNKLINE\r\n${exe}--b\r\nContent-Type: applica`;
    expect(runRaw(anychild, body, cut)).toEqual(R({ implicitKeep: true }));
  });

  it('"--b-" after a part ends the list, though its line runs into the cut', () => {
    expect(runRaw(anychild, `--b\r\n${text}--b-`, cut)).toEqual(R({ implicitKeep: true }));
  });

  it('"--b" at the cut may still be a delimiter line', () => {
    expect(runRaw(anychild, `--b\r\n${text}--b`, cut)).toEqual(R({ implicitKeep: true, indeterminate: true }));
    expect(runRaw(anychild, `--b\r\n${text}--b \t`, cut)).toEqual(R({ implicitKeep: true, indeterminate: true }));
    expect(runRaw(anychild, `--b\r\n${text}--b \r`, cut)).toEqual(R({ implicitKeep: true, indeterminate: true }));
  });

  it("in LF mode, a CR after the boundary at the cut cannot make a delimiter line", () => {
    const body = "--b\nContent-Type: text/plain\n\nhello\n--b\r";
    expect(runRaw(anychild, body, cut)).toEqual(R({ implicitKeep: true }));
  });

  it("a part header block that reaches the cut is unknown, though complete it would be a part", () => {
    const body = `--b\r\n${text}--b\r\nContent-Type: application/x-msdownload`;
    expect(runRaw(anychild, body, cut)).toEqual(R({ implicitKeep: true, indeterminate: true }));
    // A junk line may follow the last whole line, or a folded one.
    expect(runRaw(anychild, `${body}\r\n`, cut)).toEqual(R({ implicitKeep: true, indeterminate: true }));
    // A cut right after the delimiter line: no header line seen yet.
    expect(bodyTest('body :content "text/plain" :count "ge" "2"', `--b\r\n${text}--b\r\n`, cut)).toEqual(UNKNOWN);
  });

  it("a preamble that reaches the cut: no part yet, no synthesized child", () => {
    expect(bodyTest('body :content "text/plain" :is ""', "preamble text\r\n", cut)).toEqual(UNKNOWN);
    expect(runRaw(anychild, "preamble text", cut)).toEqual(R({ implicitKeep: true, indeterminate: true }));
    // A last line that may be a delimiter is not the multipart's own text.
    expect(bodyTest('body :content "multipart" :contains "--b"', "preamble\r\n--b", cut)).toEqual(UNKNOWN);
  });

  it("a tail that may begin a delimiter is not a cut part's content", () => {
    expect(bodyTest('body :content "text/plain" :contains "--"', `--b\r\n${text}--`, cut)).toEqual(UNKNOWN);
    expect(bodyTest('body :content "text/plain" :contains "hello"', `--b\r\n${text}--`, cut)).toEqual(YES);
  });

  it("no boundary: the synthesized child is a prefix of the body", () => {
    const opts = { rootCt: "multipart/mixed", cut: true };
    expect(bodyTest('body :content "text/plain" :contains "hello"', `--b\r\n${text}`, opts)).toEqual(YES);
    expect(bodyTest('body :content "text/plain" :contains "absent"', `--b\r\n${text}`, opts)).toEqual(UNKNOWN);
  });

  it("a long preamble line before the cut ends the list there: a miss is definite", () => {
    const body = `${"p".repeat(5000)}\r\n--b\r\n${exe}--b\r\nContent-Type: te`;
    expect(runRaw(anychild, body, cut)).toEqual(R({ implicitKeep: true }));
    expect(bodyTest('body :content "text/plain" :contains "MZ"', body, cut)).toEqual(YES);
    expect(bodyTest('body :content "text/plain" :contains "absent"', body, cut)).toEqual(UNKNOWN);
  });

  it("a child whose text depends on core's buffering stays unknown", () => {
    const body = `--b\r\nJUNKLINE\r\n\r\nx`;
    expect(bodyTest('body :content "text/plain" :is ""', body, cut)).toEqual(UNKNOWN);
  });
});
