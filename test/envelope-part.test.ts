// The envelope test's envelope-part (RFC 5228 §5.4).
//
// An unsupported part threw when the test ran. Through a variable the part can
// come from the message, and a thrown execute() skips every rule (the host's
// fail-open). A part known only at run time that is not "from", "to" or
// "auth" now has no value, so the test is false for it. A literal one is
// refused at load, as Pigeonhole's compile/errors/envelope.sieve expects.

import { describe, expect, it } from "vitest";
import { compile, R, run } from "./harness.js";

const ENV = { from: "alice@example.org", to: "bob@example.net" };
const fromHeader = (test: string) => `require ["envelope","variables","fileinto"];
  if header :matches "x-p" "*" { if ${test} { fileinto "E"; } }
  fileinto "Other";`;

describe("a part from a variable", () => {
  it("an unsupported one has no value, instead of throwing", () => {
    expect(run(fromHeader('envelope :is "${1}" "x@y"'), "X-P: bogus\r\n\r\nx\r\n", ENV)).toEqual(R({ fileinto: ["Other"] }));
  });

  it("not on it is true, as for an absent header", () => {
    expect(run(fromHeader('not envelope :contains "${1}" "x"'), "X-P: bogus\r\n\r\nx\r\n", ENV)).toEqual(
      R({ fileinto: ["E", "Other"] }),
    );
  });

  it(":count does not count it", () => {
    const script = `require ["envelope","variables","relational","fileinto"];
      if header :matches "x-p" "*" { if envelope :count "eq" ["\${1}", "from"] "1" { fileinto "One"; } }`;
    expect(run(script, "X-P: bogus\r\n\r\nx\r\n", ENV)).toEqual(R({ fileinto: ["One"] }));
  });

  it("a supported one still reads its part, in any case", () => {
    expect(run(fromHeader('envelope :is "${1}" "alice@example.org"'), "X-P: FROM\r\n\r\nx\r\n", ENV)).toEqual(
      R({ fileinto: ["E", "Other"] }),
    );
  });
});

describe("a literal part (Pigeonhole compile/errors/envelope.sieve)", () => {
  it("an unknown one fails at load", () => {
    expect(() => compile('require "envelope"; if envelope :is "frop" "frop@example.org" {}')).toThrow(/envelope-part/);
    expect(() => compile('require "envelope"; if envelope :is ["to","frop"] "frop@example.org" {}')).toThrow(/envelope-part/);
  });

  it("from, to and auth load, in any case", () => {
    expect(() => compile('require "envelope"; if envelope :is ["To","FROM","auth"] "frop@example.org" {}')).not.toThrow();
  });

  it("without variables, '${...}' is a literal part, and unknown", () => {
    expect(() => compile('require "envelope"; if envelope :is "${1}" "x" {}')).toThrow(/envelope-part/);
  });
});
