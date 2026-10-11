// Issue #17: work the step budget did not see, and a decoder that was too
// lenient.

import { describe, expect, it } from "vitest";
import { R, run } from "./harness.js";

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

function time(f: () => unknown): number {
  const t0 = performance.now();
  f();
  return performance.now() - t0;
}

describe("many :contains keys over a large value", () => {
  // Mixed case, so folding it is real work for i;ascii-casemap.
  const big = `From: a@x\r\nTo: b@y\r\nSubject: hi\r\n\r\n${"Hello World ".repeat(87_382)}\r\n`;
  const keys = Array.from({ length: 1000 }, (_, i) => `"Key${i}"`).join(",");
  const script = `require ["body","fileinto"]; if body :contains [${keys}] { fileinto "Hit"; }`;

  it("fold the value once, not once per key", () => {
    // Folding a 1 MiB body per key took about 9 s for 1,000 keys.
    expect(time(() => expect(run(script, big)).toEqual(R({ implicitKeep: true })))).toBeLessThan(2000);
  });

  it("are charged by the value's size, so the budget bounds them", () => {
    expect(run(script, big, { options: { maxExecSteps: 200_000 } })).toEqual(
      R({ implicitKeep: true, indeterminate: true }),
    );
  });
});

describe(":value with many keys over a large value", () => {
  it("folds the value once, not once per key", () => {
    // Alternating case is the fold's worst input; 300 keys took 3.5 s. Some
    // 600 ms alone, past 1 s under a loaded full run: the bound tells the two
    // apart, not a run from a quiet one.
    const body = `From: a@x\r\nTo: b@y\r\nSubject: hi\r\n\r\n${"aA".repeat(512 * 1024)}\r\n`;
    const keys = Array.from({ length: 300 }, (_, i) => `"k${i}"`).join(",");
    const script = `require ["body","relational","fileinto"]; if body :value "eq" [${keys}] { fileinto "Eq"; }`;
    expect(time(() => expect(run(script, body)).toEqual(R({ implicitKeep: true })))).toBeLessThan(1500);
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

  it("twenty tests cost about what one does", () => {
    run(rules(1), eml); // warm up
    const one = time(() => run(rules(1), eml));
    const twenty = time(() => run(rules(20), eml));
    expect(twenty).toBeLessThan(one * 5);
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
