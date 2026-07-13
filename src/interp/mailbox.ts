// RFC 5490 mailbox
// extension. Provides the `mailboxexists` test and the `:create` modifier on
// fileinto (parsed in action.ts; gated on `require "mailbox"` in load.ts).
//
// Without an injected MailboxChecker, `mailboxexists` is
// optimistic — every named mailbox is assumed to exist.

import type { RuntimeData, Test } from "./runtime.js";

export class MailboxExistsTest implements Test {
  constructor(public mailboxes: string[]) {}

  check(d: RuntimeData): boolean {
    const checker = d.mailboxChecker;
    if (!checker) return true; // optimistic default
    for (const m of this.mailboxes) {
      if (!checker.exists(m)) return false;
    }
    return true;
  }
}
