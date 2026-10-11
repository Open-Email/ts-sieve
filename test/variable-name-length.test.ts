// A variable name past maxVariableNameLen (#41).
//
// set and the imap4flags commands checked a name's pattern at load but not its
// length, and setVar refused a long one when the command ran: a script loaded,
// then threw whenever a branch the message picked reached the command, and a
// thrown execute() skips every rule. The length is checked at load now.

import { describe, expect, it } from "vitest";
import { compile, R, run } from "./harness.js";

const n63 = `a${"1".repeat(62)}`;
const n64 = `a${"1".repeat(63)}`;

describe("a variable name's length is checked at load", () => {
  it("set", () => {
    expect(() => compile(`require "variables"; set "${n64}" "1";`)).toThrow(/too long/);
    expect(() => compile(`require "variables"; set "${n63}" "1";`)).not.toThrow();
  });

  it("setflag, addflag and removeflag", () => {
    for (const cmd of ["setflag", "addflag", "removeflag"]) {
      expect(() => compile(`require ["imap4flags","variables"]; ${cmd} "${n64}" "\\\\Seen";`)).toThrow(/too long/);
      expect(() => compile(`require ["imap4flags","variables"]; ${cmd} "${n63}" "\\\\Seen";`)).not.toThrow();
    }
  });

  it("hasflag only reads a variable, so a long name is not refused", () => {
    expect(() => compile(`require ["imap4flags","variables"]; if hasflag "${n64}" "x" {}`)).not.toThrow();
  });

  it("the host's maxVariableNameLen is the limit", () => {
    const opts = { options: { maxVariableNameLen: 10 } };
    expect(() => compile('require "variables"; set "a1234567890" "1";', opts)).toThrow(/too long/);
    expect(() => compile('require "variables"; set "a123456789" "1";', opts)).not.toThrow();
  });

  it("the default is Pigeonhole's 63: a 33-character name that once threw now runs", () => {
    const n33 = `a${"1".repeat(32)}`;
    const script = `require ["variables","fileinto"]; if header :contains "x-p" "go" { set "${n33}" "1"; } fileinto "A";`;
    expect(run(script, "X-P: go\r\n\r\nx\r\n")).toEqual(R({ fileinto: ["A"] }));
  });

  it("the issue's shape, past the limit: fails at load instead of when the branch runs", () => {
    const script = `require ["variables","fileinto"]; if header :contains "x-p" "go" { set "${n64}" "1"; } fileinto "A";`;
    expect(() => compile(script)).toThrow(/too long/);
  });
});
