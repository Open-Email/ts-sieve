// Block-loading conformance fixtures.
//
// These drive block loading and assert the loaded Cmd AST structure (e.g. the
// envelope test defaults comparator=i;ascii-casemap, match=is, matchCnt=1; and
// load-time flag canonicalization folding "flag1 flag2" -> {flag1,flag2}). Every
// case expects success, i.e. block loading MUST succeed — so these are
// compile-success cases. The harness exposes no AST inspection, so the proxy is
// `compile()` succeeding (loading with all extensions enabled). Scripts are
// written verbatim, tabs and all.

import { describe, expect, it } from "vitest";
import { compile } from "./harness.js";

describe("load block", () => {
  it("require loads to an empty block", () => {
    expect(() => compile(`require ["envelope"];`)).not.toThrow();
  });

  it("if true with empty block", () => {
    expect(() => compile(`if true { }`)).not.toThrow();
  });

  it("envelope :is test with fileinto block", () => {
    expect(() =>
      compile(`require "envelope";
require "fileinto";
if envelope :is "from" "test@example.org" {
	fileinto "hell";
}
`),
    ).not.toThrow();
  });

  it("imap4flags fileinto/keep/setflag/addflag/removeflag", () => {
    expect(() =>
      compile(`require "imap4flags";
require "fileinto";
fileinto :flags "flag1 flag2" "hell";
keep :flags ["flag1", "flag2"];
setflag ["flag2", "flag1", "flag2"];
addflag ["flag2", "flag1"];
removeflag "flag2";
`),
    ).not.toThrow();
  });
});
