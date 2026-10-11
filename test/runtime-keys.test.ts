// `:matches`/`:regex` keys built from message data at delivery.
//
// A key holding a variable reference compiles only when the test runs, and a
// compile error used to throw out of execute(). The data can come from the
// message, and a thrown execute() skips every rule (the host's fail-open), so
// a sender could bypass the recipient's filtering with a From header. Such a
// key now answers "unknown": its comparison does not fire and the guess is
// disclosed on `indeterminate`. A key written literally in the script still
// fails at load, where the author can fix it.

import { describe, expect, it } from "vitest";
import { compile, R, run } from "./harness.js";

const msg = (headers: Record<string, string>) =>
  `${Object.entries(headers)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\r\n")}\r\n\r\nbody\r\n`;

const fromKey = (test: string) =>
  `require ["regex","variables","fileinto"];
   if header :matches "from" "*" { if ${test} { fileinto "X"; } }
   fileinto "Other";`;

describe("a :regex key that does not compile", () => {
  it("is unknown instead of throwing, and the rest of the script runs", () => {
    expect(run(fromKey('header :regex "subject" "${1}"'), msg({ From: "(a", Subject: "(a" }))).toEqual(
      R({ fileinto: ["Other"], indeterminate: true }),
    );
  });

  it("stays unknown under not, so a not-guarded rule does not fire", () => {
    expect(run(fromKey('not header :regex "subject" "${1}"'), msg({ From: "a[", Subject: "x" }))).toEqual(
      R({ fileinto: ["Other"], indeterminate: true }),
    );
  });

  it("a later key that matches still decides the test", () => {
    expect(run(fromKey('header :regex "subject" ["${1}", "^hi$"]'), msg({ From: "a)", Subject: "hi" }))).toEqual(
      R({ fileinto: ["X", "Other"] }),
    );
  });

  it("a repetition count past the cap is unknown too", () => {
    expect(run(fromKey('header :regex "subject" "${1}"'), msg({ From: "a{5000}", Subject: "a" }))).toEqual(
      R({ fileinto: ["Other"], indeterminate: true }),
    );
  });

  it("the string test takes the same path", () => {
    expect(run(fromKey('string :regex "abc" "${1}"'), msg({ From: "(a" }))).toEqual(
      R({ fileinto: ["Other"], indeterminate: true }),
    );
  });
});

describe("a key longer than the pattern cap once expanded", () => {
  const listId = `<${"x".repeat(1200)}.lists.example.com>`;
  const script = `require ["variables","fileinto"];
    if header :matches "list-id" "*" {
      set :quotewildcard "l" "\${1}";
      if header :matches "subject" "*\${l}*" { fileinto "List"; }
    }
    fileinto "Other";`;

  it("is unknown instead of throwing (the issue's List-Id case)", () => {
    expect(run(script, msg({ "List-Id": listId, Subject: `re: ${listId}` }))).toEqual(
      R({ fileinto: ["Other"], indeterminate: true }),
    );
  });

  it("a :regex key past the cap is unknown too", () => {
    expect(run(fromKey('header :regex "subject" "${1}"'), msg({ From: "a".repeat(1200), Subject: "a" }))).toEqual(
      R({ fileinto: ["Other"], indeterminate: true }),
    );
  });
});

describe("deleteheader with a key that does not compile", () => {
  it("deletes nothing, discloses the guess, and does not throw", () => {
    const script = `require ["regex","variables","editheader","fileinto"];
      if header :matches "from" "*" { deleteheader :regex "x-tag" "\${1}"; }
      if exists "x-tag" { fileinto "Tagged"; }`;
    expect(run(script, msg({ From: "(a", "X-Tag": "(a" }))).toEqual(R({ fileinto: ["Tagged"], indeterminate: true }));
  });
});

describe("a key written literally in the script", () => {
  it("still fails at load", () => {
    expect(() => compile('require "regex"; if header :regex "subject" "(a" { keep; }')).toThrow(/regex/);
  });

  it("a literal key past the cap still fails at load", () => {
    expect(() => compile(`require "regex"; if header :regex "subject" "${"a".repeat(1001)}" { keep; }`)).toThrow(
      /too long/,
    );
  });
});
