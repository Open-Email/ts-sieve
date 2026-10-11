// RFC 5703 §7 extracttext, over a body the host's read window cut.
//
// extracttext stores the current part's text (transfer- and charset-decoded,
// HTML reduced to text) in a variable, at most as many octets as the engine
// matches. A variable carries no "this is a prefix" mark, so a value from a
// part the cut (or that limit) left incomplete is a guess every later test
// would treat as fact: it is disclosed as indeterminate, unless :first asked
// for no more than was read.

import { describe, expect, it } from "vitest";
import { R, run } from "./harness.js";

const CUT = { bodyTruncated: true };
const one = (body: string, ct = "text/plain") => `From: a@x\r\nTo: b@y\r\nContent-Type: ${ct}\r\n\r\n${body}`;
const extract = (args: string) =>
  `require ["foreverypart","extracttext","variables","fileinto"];
   foreverypart { extracttext ${args} "t"; fileinto "[\${t}]"; }`;

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
