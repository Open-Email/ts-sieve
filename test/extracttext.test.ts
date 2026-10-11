// RFC 5703 §7 extracttext, over a body the host's read window cut.
//
// extracttext stores the current part's text (transfer- and charset-decoded,
// HTML reduced to text) in a variable, at most as many octets as the engine
// matches. A variable carries no "this is a prefix" mark, so a value from a
// part the cut (or that limit) left incomplete is a guess every later test
// would treat as fact: it is disclosed as indeterminate, unless :first asked
// for no more than was read.

import { describe, expect, it } from "vitest";
import { DummyPolicy, EnvelopeStatic, load, MessageStatic, newRuntimeData } from "../src/index.js";
import { ALL_EXTENSIONS, compile, parseEml, R, run } from "./harness.js";

const CUT = { bodyTruncated: true };
const one = (body: string, ct = "text/plain") => `From: a@x\r\nTo: b@y\r\nContent-Type: ${ct}\r\n\r\n${body}`;
const extract = (args: string) =>
  `require ["foreverypart","extracttext","variables","fileinto"];
   foreverypart { extracttext ${args} "t"; fileinto "[\${t}]"; if string :contains "\${t}" "~never~" { stop; } }`;

// Each script reads `t` for a key it never holds: false over whole text,
// unknown over a marked value, which then discloses (see the README's
// indeterminate: a value is marked, not the run).
describe("extracttext", () => {
  it("a whole part is exact", () => {
    expect(run(extract(""), one("hello world"))).toEqual(R({ fileinto: ["[hello world]"] }));
  });

  it("HTML is reduced to its text", () => {
    expect(run(extract(""), one("<p>hello <b>world</b></p>", "text/html"))).toEqual(R({ fileinto: ["[hello world]"] }));
  });

  it("a cut part is disclosed", () => {
    expect(run(extract(""), one("hello wor"), CUT)).toEqual(R({ fileinto: ["[hello wor]"], indeterminate: true }));
  });

  it(":first within what the cut left is exact", () => {
    expect(run(extract(":first 5"), one("hello wor"), CUT)).toEqual(R({ fileinto: ["[hello]"] }));
  });

  it(":first past what the cut left is disclosed", () => {
    expect(run(extract(":first 50"), one("hello wor"), CUT)).toEqual(R({ fileinto: ["[hello wor]"], indeterminate: true }));
  });

  it("past the engine's input limit, the value is cut and disclosed", () => {
    const r = run(extract(""), one("x".repeat(100)), { options: { maxMatchInputLength: 10 } });
    expect(r).toEqual(R({ fileinto: [`[${"x".repeat(10)}]`], indeterminate: true }));
  });

  it("a multipart part has no text of its own", () => {
    const eml = "From: a@x\r\nTo: b@y\r\nContent-Type: multipart/mixed; boundary=b\r\n\r\n--b\r\nContent-Type: text/plain\r\n\r\nin\r\n--b--\r\n";
    expect(run(extract(""), eml)).toEqual(R({ fileinto: ["[]", "[in]"] }));
  });

  it("an unknown charset gives an empty string (RFC 5703 §7)", () => {
    expect(run(extract(""), one("hello", "text/plain; charset=x-unknown-charset"))).toEqual(R({ fileinto: ["[]"] }));
  });

  it("a body the host did not read is disclosed", () => {
    expect(run(extract(""), "From: a@x\r\nTo: b@y\r\n")).toEqual(R({ fileinto: ["[]"], indeterminate: true }));
  });
});

/** Run against a single-part body given as bytes, so a cut can split a character. */
function runBytes(script: string, ct: string, body: number[], opts: { cut?: boolean; cte?: string; limit?: number } = {}) {
  const s = load(script, { enabledExtensions: ALL_EXTENSIONS, maxMatchInputLength: opts.limit ?? 0, maxExecSteps: 0 });
  const headers = new Map([["content-type", [ct]]]);
  if (opts.cte) headers.set("content-transfer-encoding", [opts.cte]);
  const d = newRuntimeData(s, new DummyPolicy(), new EnvelopeStatic(), new MessageStatic(0, headers, Uint8Array.from(body), opts.cut ?? false));
  s.execute(d);
  return { fileinto: d.mailboxes, indeterminate: d.indeterminate };
}
const bytes = (s: string) => Array.from(new TextEncoder().encode(s));
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

describe("the variable size limit", () => {
  it("a value cut to maxVariableLen is disclosed", () => {
    // 4,500 characters: the variable keeps 4,000, and a not-guarded rule must
    // not stand on that as fact.
    const script = `require ["foreverypart","extracttext","variables","fileinto"];
      foreverypart { extracttext "t"; if not string :contains "\${t}" "unsubscribe" { fileinto "NoUnsub"; } }`;
    expect(run(script, one(`${"x".repeat(4500)} unsubscribe`))).toMatchObject({ indeterminate: true });
  });

  it("exactly maxVariableLen bytes is exact; a byte more is disclosed", () => {
    expect(run(extract(""), one("x".repeat(4000))).indeterminate).toBe(false);
    expect(run(extract(""), one("x".repeat(4001))).indeterminate).toBe(true);
  });

  it(":quotewildcard pushing the value past the limit is disclosed", () => {
    // 2,500 "*" quote to 5,000 bytes, cut back to the limit before it is set.
    expect(run(extract(":quotewildcard"), one("*".repeat(2500))).indeterminate).toBe(true);
  });

  it(":first counts characters, and a long first is still cut by bytes", () => {
    expect(run(extract(":first 2000"), one("日".repeat(3000), "text/plain; charset=utf-8")).indeterminate).toBe(true);
  });

  it(":first over astral characters counts them whole", () => {
    expect(run(extract(":first 2"), one("😀😀😀", "text/plain; charset=utf-8"))).toEqual(R({ fileinto: ["[😀😀]"] }));
  });
});

describe("decoding", () => {
  const ex = 'require ["foreverypart","extracttext","variables","fileinto"]; foreverypart { extracttext "t"; fileinto "[${t}]"; if string :contains "${t}" "~never~" { stop; } }';

  it("quoted-printable and base64", () => {
    expect(runBytes(ex, "text/plain; charset=utf-8", ascii("caf=C3=A9"), { cte: "quoted-printable" }).fileinto).toEqual(["[café]"]);
    expect(runBytes(ex, "text/plain", ascii("aGVsbG8="), { cte: "base64" }).fileinto).toEqual(["[hello]"]);
  });

  it("the utf16 label decodes as the body test decodes it", () => {
    expect(runBytes(ex, "text/plain; charset=utf16", [0, 0x68, 0, 0x69]).fileinto).toEqual(["[hi]"]);
  });

  it("latin1, and utf-16 by its BOM or big-endian without one (RFC 2781)", () => {
    expect(runBytes(ex, "text/plain; charset=iso-8859-1", [0x63, 0x61, 0x66, 0xe9]).fileinto).toEqual(["[café]"]);
    expect(runBytes(ex, "text/plain; charset=utf-16", [0, 0x68, 0, 0x69]).fileinto).toEqual(["[hi]"]);
    expect(runBytes(ex, "text/plain; charset=utf-16", [0xff, 0xfe, 0x68, 0, 0x69, 0]).fileinto).toEqual(["[hi]"]);
    expect(runBytes(ex, "text/plain; charset=utf-16", [0xfe, 0xff, 0, 0x68, 0, 0x69]).fileinto).toEqual(["[hi]"]);
  });

  it("a non-text leaf is its decoded content; xhtml is reduced like html", () => {
    expect(runBytes(ex, "application/octet-stream", ascii("abc")).fileinto).toEqual(["[abc]"]);
    expect(runBytes(ex, "application/xhtml+xml", ascii("<p>a <b>b</b></p>")).fileinto).toEqual(["[a b]"]);
  });

  it("a part's transfer encoding is the first of two, as core's MIME walker (and the body test) reads it", () => {
    const eml = [
      "From: a@x",
      "To: b@y",
      "Content-Type: multipart/mixed; boundary=b",
      "",
      "--b",
      "Content-Type: text/plain",
      "Content-Transfer-Encoding: base64",
      "Content-Transfer-Encoding: 7bit",
      "",
      "aGVsbG8=",
      "--b--",
      "",
    ].join("\r\n");
    expect(run(ex, eml).fileinto).toEqual(["[]", "[hello]"]);
  });
});

describe("a cut left open in the decoding", () => {
  const ex = 'require ["foreverypart","extracttext","variables","fileinto"]; foreverypart { extracttext "t"; fileinto "[${t}]"; if string :contains "${t}" "~never~" { stop; } }';

  it("inside a UTF-8 sequence, a QP escape, an HTML entity", () => {
    expect(runBytes(ex, "text/plain; charset=utf-8", [...ascii("caf"), 0xc3], { cut: true })).toEqual({ fileinto: ["[caf]"], indeterminate: true });
    expect(runBytes(ex, "text/plain; charset=utf-8", ascii("caf=C"), { cut: true, cte: "quoted-printable" })).toEqual({
      fileinto: ["[caf]"],
      indeterminate: true,
    });
    expect(runBytes(ex, "text/html", ascii("a &am"), { cut: true })).toEqual({ fileinto: ["[a]"], indeterminate: true });
  });

  // The loop breaks once it has the text, so it discloses nothing itself:
  // only extracttext's own disclosure can set indeterminate.
  // "hello" is in the prefix, so the rule decides; the probe after it can only
  // be unknown if the nested part's cut marked the text.
  const found = 'require ["foreverypart","extracttext","variables","fileinto"]; foreverypart { extracttext "t"; if string :contains "${t}" "hello" { fileinto "[${t}]"; if string :contains "${t}" "~never~" { stop; } break; } }';

  it("inside a part nested in a multipart", () => {
    const eml =
      "From: a@x\r\nTo: b@y\r\nContent-Type: multipart/mixed; boundary=o\r\n\r\n--o\r\nContent-Type: multipart/mixed; boundary=i\r\n\r\n--i\r\nContent-Type: text/plain\r\n\r\nhello wor";
    expect(run(found, eml, CUT)).toEqual(R({ fileinto: ["[hello wor]"], indeterminate: true }));
  });

  it("inside a nested message", () => {
    const eml = "From: a@x\r\nTo: b@y\r\nContent-Type: message/rfc822\r\n\r\nSubject: s\r\nContent-Type: text/plain\r\n\r\nhello wor";
    expect(run(found, eml, CUT)).toEqual(R({ fileinto: ["[hello wor]"], indeterminate: true }));
  });

  it("a UTF-16 code unit split by the cut, whichever byte order", () => {
    const first2 = 'require ["foreverypart","extracttext","variables","fileinto"]; foreverypart { extracttext :first 2 "t"; fileinto "[${t}]"; if string :contains "${t}" "~never~" { stop; } }';
    const utf16 = (b: number[]) => runBytes(first2, "text/plain; charset=utf-16", b, { cut: true });
    // Little-endian behind its BOM; big-endian behind its BOM and without one.
    expect(utf16([0xff, 0xfe, 0x68, 0, 0x69])).toEqual({ fileinto: ["[h]"], indeterminate: true });
    expect(utf16([0xfe, 0xff, 0, 0x68, 0])).toEqual({ fileinto: ["[h]"], indeterminate: true });
    expect(utf16([0, 0x68, 0])).toEqual({ fileinto: ["[h]"], indeterminate: true });
  });

  it("a non-text leaf's character split by the cut", () => {
    const first3 = 'require ["foreverypart","extracttext","variables","fileinto"]; foreverypart { extracttext :first 3 "t"; fileinto "[${t}]"; if string :contains "${t}" "~never~" { stop; } }';
    expect(runBytes(first3, "application/octet-stream", [0x61, 0x62, 0xc3], { cut: true })).toEqual({ fileinto: ["[ab]"], indeterminate: true });
  });

  it(":first exactly the characters read is exact", () => {
    const first9 = 'require ["foreverypart","extracttext","variables","fileinto"]; foreverypart { extracttext :first 9 "t"; fileinto "[${t}]"; if string :contains "${t}" "~never~" { stop; } }';
    expect(run(first9, one("hello wor"), CUT)).toEqual(R({ fileinto: ["[hello wor]"] }));
  });

  it("an undecodable part on a cut is \"\" and complete: there is no text to miss", () => {
    expect(runBytes(ex, "text/plain; charset=x-unknown", ascii("abc"), { cut: true })).toEqual({ fileinto: ["[]"], indeterminate: false });
    expect(runBytes(ex, "text/plain", ascii("abc"), { cut: true, cte: "x-uuencode" })).toEqual({ fileinto: ["[]"], indeterminate: false });
  });

  it("the decode limit is a cut only past it", () => {
    expect(runBytes(ex, "text/plain", ascii("0123456789"), { limit: 10 }).indeterminate).toBe(false);
    expect(runBytes(ex, "text/plain", ascii("0123456789a"), { limit: 10 }).indeterminate).toBe(true);
  });
});

describe("cost", () => {
  it("each call is charged by the text's size", () => {
    const LIMIT = 100_000_000;
    const calls = Array.from({ length: 10 }, () => 'extracttext "t";').join(" ");
    const s = load(`require ["foreverypart","extracttext","variables"]; foreverypart { ${calls} }`, {
      enabledExtensions: ALL_EXTENSIONS,
      maxExecSteps: LIMIT,
    });
    const { headers, size, body } = parseEml(one("x".repeat(100_000)));
    const d = newRuntimeData(s, new DummyPolicy(), new EnvelopeStatic(), new MessageStatic(size, headers, body));
    s.execute(d);
    // Ten calls and one decode of the part, each a step per KiB.
    expect(LIMIT - d.budget.remaining).toBeGreaterThan(11 * (100_000 >> 10));
  });

  it("conflicting modifiers fail at load", () => {
    expect(() => compile('require ["foreverypart","extracttext","variables"]; foreverypart { extracttext :lower :upper "t"; }')).toThrow(
      /conflicting/,
    );
  });
});
