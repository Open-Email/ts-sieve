// Issue #17: work the step budget did not see, and a decoder that was too
// lenient.
//
// That work is counted, not timed: a bound loose enough for a loaded runner
// under coverage let the regression pass on a quiet machine (#71).

import { describe, expect, it, vi } from "vitest";
import { DummyPolicy, EnvelopeStatic, load, MessageStatic, newRuntimeData } from "../src/index.js";
import { ALL_EXTENSIONS, parseEml, R, run } from "./harness.js";

// The HTML a run reduces, counted where the body test imports the reduction.
const reduced = vi.hoisted(() => ({ count: 0 }));
vi.mock("../src/interp/htmltext.js", async (importOriginal) => {
  const m = await importOriginal<typeof import("../src/interp/htmltext.js")>();
  return {
    ...m,
    htmlToText: (s: string, cut?: boolean) => {
      reduced.count++;
      return m.htmlToText(s, cut);
    },
  };
});

const qp = (body: string) =>
  `From: a@x\r\nTo: b@y\r\nSubject: hi\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n${body}`;
const is = (key: string) => `require ["body","fileinto"]; if body :content "text/plain" :is "${key}" { fileinto "Is"; }`;

describe("quoted-printable takes two hex digits after '='", () => {
  // Number.parseInt read "4x" as 4, " 4" as 4 and "-1" as -1: each became a
  // stray byte. Anything but two hex digits stays text, as in Pigeonhole.
  for (const [encoded, decoded] of [
    ["a=4xb", "a=4xb"],
    ["a= 4b", "a= 4b"],
    ["a=-1b", "a=-1b"],
    ["a=+fb", "a=+fb"],
    ["a=G1b", "a=G1b"],
  ]) {
    it(`${encoded} is ${decoded}`, () => {
      expect(run(is(decoded!), qp(encoded!))).toEqual(R({ fileinto: ["Is"] }));
    });
  }

  it("soft line breaks still join lines", () => {
    expect(run(is("café"), qp("caf=\r\n=C3=A9"))).toEqual(R({ fileinto: ["Is"] }));
    expect(run(is("ab"), qp("a=\nb"))).toEqual(R({ fileinto: ["Is"] }));
  });

  it("the hex digits are 0-9, a-f and A-F, no further", () => {
    expect(run(is("aOb"), qp("a=4fb"))).toEqual(R({ fileinto: ["Is"] }));
    expect(run(is("aOb"), qp("a=4Fb"))).toEqual(R({ fileinto: ["Is"] }));
    expect(run(is("a=g1b"), qp("a=g1b"))).toEqual(R({ fileinto: ["Is"] }));
    expect(run(is("a=4gb"), qp("a=4gb"))).toEqual(R({ fileinto: ["Is"] }));
  });

  it("upper- and lower-case hex both decode", () => {
    expect(run(is("café"), qp("caf=C3=A9"))).toEqual(R({ fileinto: ["Is"] }));
    expect(run(is("café"), qp("caf=c3=a9"))).toEqual(R({ fileinto: ["Is"] }));
  });
});

/** How many times f folds a value of a million characters or more: every
 * i;ascii-casemap fold begins by asking whether the value holds a capital (a
 * fold that stops asking counts none, and fails these tests rather than
 * passing them). */
function foldsOf(f: () => unknown): number {
  let folds = 0;
  const test = RegExp.prototype.test;
  const spy = vi.spyOn(RegExp.prototype, "test").mockImplementation(function (this: RegExp, s: string) {
    if (this.source === "[A-Z]" && s.length >= 1_000_000) folds++;
    return test.call(this, s);
  });
  try {
    f();
  } finally {
    spy.mockRestore();
  }
  return folds;
}

/** A body that counts the times it is read from its start. */
class CountedBody extends Uint8Array {
  passes = 0;
  override subarray(begin?: number, end?: number) {
    if (!begin) this.passes++;
    return super.subarray(begin, end);
  }
}

describe("many :contains keys over a large value", () => {
  // Mixed case, so folding it is real work for i;ascii-casemap.
  const big = `From: a@x\r\nTo: b@y\r\nSubject: hi\r\n\r\n${"Hello World ".repeat(87_382)}\r\n`;
  const keys = Array.from({ length: 1000 }, (_, i) => `"Key${i}"`).join(",");
  const script = `require ["body","fileinto"]; if body :contains [${keys}] { fileinto "Hit"; }`;

  it("fold the value once, not once per key", { timeout: 30_000 }, () => {
    // Folding a 1 MiB body per key took about 9 s for 1,000 keys.
    expect(foldsOf(() => expect(run(script, big)).toEqual(R({ implicitKeep: true })))).toBe(1);
  });

  it("are charged by the value's size, so the budget bounds them", () => {
    expect(run(script, big, { options: { maxExecSteps: 200_000 } })).toEqual(
      R({ implicitKeep: true, indeterminate: true }),
    );
  });
});

describe(":value with many keys over a large value", () => {
  it("folds the value once, not once per key", { timeout: 30_000 }, () => {
    // Alternating case is the fold's worst input; 300 keys took 3.5 s.
    const body = `From: a@x\r\nTo: b@y\r\nSubject: hi\r\n\r\n${"aA".repeat(512 * 1024)}\r\n`;
    const keys = Array.from({ length: 300 }, (_, i) => `"k${i}"`).join(",");
    const script = `require ["body","relational","fileinto"]; if body :value "eq" [${keys}] { fileinto "Eq"; }`;
    expect(foldsOf(() => expect(run(script, body)).toEqual(R({ implicitKeep: true })))).toBe(1);
  });
});

describe("a part whose transfer encoding is not decoded", () => {
  it("is skipped, and not counted", () => {
    const eml = [
      "From: a@x",
      "To: b@y",
      "Content-Type: multipart/mixed; boundary=b",
      "",
      "--b",
      "Content-Type: text/plain",
      "",
      "one",
      "--b",
      "Content-Type: text/plain",
      "Content-Transfer-Encoding: x-uuencode",
      "",
      "two",
      "--b--",
      "",
    ].join("\r\n");
    const script = 'require ["body","relational","fileinto"]; if body :count "eq" "1" { fileinto "One"; }';
    expect(run(script, eml)).toEqual(R({ fileinto: ["One"] }));
  });
});

describe("repeated body :text tests reduce each HTML part once", () => {
  const html = `<html><body>${"<p>para <b>bold</b> &amp; text</p>".repeat(30_000)}</body></html>`;
  const eml = `From: a@x\r\nTo: b@y\r\nSubject: hi\r\nContent-Type: text/html; charset=utf-8\r\n\r\n${html}\r\n`;
  const rules = (n: number) =>
    `require ["body","fileinto"]; ${Array.from({ length: n }, (_, i) => `if body :text :contains "zz${i}" { fileinto "T${i}"; }`).join(" ")}`;

  it("twenty tests read the body once and reduce it once", () => {
    // Each test converted the raw body to a binary string, and decoded and
    // reduced the part again: twenty cost twenty times one.
    const { headers, size, body } = parseEml(eml);
    const raw = new CountedBody(body!);
    const s = load(rules(20), { enabledExtensions: ALL_EXTENSIONS });
    const d = newRuntimeData(s, new DummyPolicy(), new EnvelopeStatic("a@x", "b@y"), new MessageStatic(size, headers, raw));
    reduced.count = 0;
    s.execute(d);
    expect([d.implicitKeep, raw.passes, reduced.count]).toEqual([true, 1, 1]);
  });

  it("each test still sees the reduced text", () => {
    const script = `require ["body","fileinto"];
      if body :text :contains "bold & text" { fileinto "A"; }
      if body :text :contains "<b>" { fileinto "B"; }
      if body :raw :contains "<b>" { fileinto "C"; }
      if body :content "text/html" :contains "&amp;" { fileinto "D"; }`;
    expect(run(script, eml)).toEqual(R({ fileinto: ["A", "C", "D"] }));
  });
});
