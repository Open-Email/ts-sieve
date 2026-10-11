// RFC 5490 mailbox
// extension. Provides the `mailboxexists` test and the `:create` modifier on
// fileinto (parsed in action.ts; gated on `require "mailbox"` in load.ts).
//
// Without an injected MailboxChecker, `mailboxexists` is
// optimistic — every named mailbox is assumed to exist.

import type { RuntimeData, Test } from "./runtime.js";
import { expandMarked } from "./variables.js";

export class MailboxExistsTest implements Test {
  /** It sets no captures (see test.ts setsCaptures). */
  readonly setsCaptures = false;

  constructor(public mailboxes: string[]) {}

  check(d: RuntimeData): boolean {
    const checker = d.mailboxChecker;
    if (!checker) return true; // optimistic default
    for (const m of this.mailboxes) {
      d.budget.consume(1); // a step a name the host is asked about
      // Expanded (RFC 5490 §3.1 exempts no argument). A name built from a
      // marked value is not the whole input's: the host is not asked about
      // it, and the answer is unknown, as for exists (see SharedTest).
      const { value, mark } = expandMarked(d, m);
      if (mark !== "") {
        d.testDoubt = true;
        continue;
      }
      if (!checker.exists(value)) return false;
    }
    return true;
  }
}
