// A variable name past maxVariableNameLen (#41).
//
// set and the imap4flags commands checked a name's pattern at load but not its
// length, and setVar refused a long one when the command ran: a script loaded,
// then threw whenever a branch the message picked reached the command, and a
// thrown execute() skips every rule. The length is checked at load now.

import { describe, expect, it } from "vitest";
import { compile, R, run } from "./harness.js";

const n32 = `a${"1".repeat(31)}`;
const n33 = `a${"1".repeat(32)}`;

describe("a variable name's length is checked at load", () => {
  it("set", () => {
    expect(() => compile(`require "variables"; set "${n33}" "1";`)).toThrow(/too long/);
    expect(() => compile(`require "variables"; set "${n32}" "1";`)).not.toThrow();
  });

  it("setflag, addflag and removeflag", () => {
    for (const cmd of ["setflag", "addflag", "removeflag"]) {
      expect(() => compile(`require ["imap4flags","variables"]; ${cmd} "${n33}" "\\\\Seen";`)).toThrow(/too long/);
      expect(() => compile(`require ["imap4flags","variables"]; ${cmd} "${n32}" "\\\\Seen";`)).not.toThrow();
    }
  });

  it("hasflag", () => {
    expect(() => compile(`require ["imap4flags","variables"]; if hasflag "${n33}" "x" {}`)).toThrow(/too long/);
  });

  it("the host's maxVariableNameLen is the limit", () => {
    expect(() => compile(`require "variables"; set "${n33}" "1";`, { options: { maxVariableNameLen: 63 } })).not.toThrow();
  });

  it("the issue's case no longer throws when the branch runs: it fails at load", () => {
    const script = `require ["variables","fileinto"]; if header :contains "x-p" "go" { set "${n33}" "1"; } fileinto "A";`;
    expect(() => compile(script)).toThrow(/too long/);
    expect(run(script.replace(n33, n32), "X-P: go\r\n\r\nx\r\n")).toEqual(R({ fileinto: ["A"] }));
  });
});
