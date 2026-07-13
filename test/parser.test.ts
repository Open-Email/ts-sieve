// Parser conformance fixtures. Lexed with noPosition, so every AST node's
// position is {0,0}; helpers default to that.

import { describe, expect, it } from "vitest";
import { lex } from "../src/lexer/lex.js";
import { Stream } from "../src/lexer/stream.js";
import type { Arg, Cmd, Test } from "../src/parser/command.js";
import { parse } from "../src/parser/parse.js";

const P = { line: 0, col: 0 };
const sArg = (value: string): Arg => ({ kind: "string", value, ...P });
const slArg = (value: string[]): Arg => ({ kind: "stringList", value, ...P });
const tag = (value: string): Arg => ({ kind: "tag", value, ...P });
const test = (id: string, o: { args?: Arg[]; tests?: Test[] } = {}): Test => ({
  id,
  args: o.args ?? [],
  tests: o.tests ?? [],
  ...P,
});
const cmd = (id: string, o: { args?: Arg[]; tests?: Test[]; block?: Cmd[] | null } = {}): Cmd => ({
  id,
  args: o.args ?? [],
  tests: o.tests ?? [],
  block: o.block ?? null,
  ...P,
});

const exampleScript = ` #
    # Example Sieve Filter
    # Declare any optional features or extension used by the script
    #
    require ["fileinto"];

    #
    # Handle messages from known mailing lists
    # Move messages from IETF filter discussion list to filter mailbox
    #
    if header :is "Sender" "owner-ietf-mta-filters@imc.org"
            {
            fileinto "filter";  # move to "filter" mailbox
            }
    #
    # Keep all messages to or from people in my company
    #
    elsif address :DOMAIN :is ["From", "To"] "example.com"
            {
            keep;               # keep in "In" mailbox
            }

    #
    # Try and catch unsolicited email.  If a message is not to me,
    # or it contains a subject known to be spam, file it away.
    #
    elsif anyof (NOT address :all :contains
                   ["To", "Cc", "Bcc"] "me@example.com",
                 header :matches "subject"
                   ["*make*money*fast*", "*university*dipl*mas*"])
            {
            fileinto "spam";   # move to "spam" mailbox
            }
    else
            {
            # Move all other (non-company) mail to "personal"
            # mailbox.
            fileinto "personal";
            }
`;

describe("parser", () => {
  it("parses the RFC 5228 example script", () => {
    const toks = lex(exampleScript, { noPosition: true });
    const cmds = parse(new Stream(toks), {});
    expect(cmds).toEqual([
      cmd("require", { args: [slArg(["fileinto"])] }),
      cmd("if", {
        tests: [test("header", { args: [tag("is"), sArg("Sender"), sArg("owner-ietf-mta-filters@imc.org")] })],
        block: [cmd("fileinto", { args: [sArg("filter")] })],
      }),
      cmd("elsif", {
        tests: [test("address", { args: [tag("DOMAIN"), tag("is"), slArg(["From", "To"]), sArg("example.com")] })],
        block: [cmd("keep")],
      }),
      cmd("elsif", {
        tests: [
          test("anyof", {
            tests: [
              test("NOT", {
                tests: [
                  test("address", {
                    args: [tag("all"), tag("contains"), slArg(["To", "Cc", "Bcc"]), sArg("me@example.com")],
                  }),
                ],
              }),
              test("header", {
                args: [tag("matches"), sArg("subject"), slArg(["*make*money*fast*", "*university*dipl*mas*"])],
              }),
            ],
          }),
        ],
        block: [cmd("fileinto", { args: [sArg("spam")] })],
      }),
      cmd("else", { block: [cmd("fileinto", { args: [sArg("personal")] })] }),
    ]);
  });
});
