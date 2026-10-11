// RFC 5490 mailbox
// extension. Provides the `mailboxexists` test and the `:create` modifier on
// fileinto (parsed in action.ts; gated on `require "mailbox"` in load.ts).
//
// Without an injected MailboxChecker, `mailboxexists` is
// optimistic — every named mailbox is assumed to exist.

import type { RuntimeData, Test } from "./runtime.js";
import { expandVars } from "./variables.js";

export class MailboxExistsTest implements Test {
  /** It sets no captures (see test.ts setsCaptures). */
  readonly setsCaptures = false;

  constructor(public mailboxes: string[]) {}

  check(d: RuntimeData): boolean {
    const checker = d.mailboxChecker;
    if (!checker) return true; // optimistic default
    for (const m of this.mailboxes) {
      d.budget.consume(1); // a step a name the host is asked about
      // Expanded (RFC 5490 §3.1 exempts no argument): a name built from a
      // marked value is not the whole input's, and the answer is unknown, as
      // for exists (see SharedTest).
      if (!checker.exists(expandVars(d, m))) return false;
    }
    return true;
  }
}
