// RFC 5429 reject / ereject. The action cancels the implicit keep and records
// the refusal in RuntimeData.rejected, rejectReason and rejectExtended; the
// host refuses the message. The RFC's order: refuse in the protocol (a 5xx at
// SMTP/LMTP time) where possible; failing that, a DSN (ereject) or a failure
// MDN (reject) to the envelope sender — not for a null or forged sender, nor,
// for reject, likely spam. RFC 5429 §2.1 makes ereject unavailable where
// protocol-level refusal is not possible, so a host that can only drop the
// message (one that runs after the message was accepted) departs from it, and
// §4 warns that the sender is then never told.

import { SieveError } from "../errors.js";
import type { Cmd, RuntimeData } from "./runtime.js";
import { expandVars } from "./variables.js";

export class CmdReject implements Cmd {
  reason = "";

  constructor(readonly extended: boolean) {}

  execute(d: RuntimeData): void {
    // RFC 5429 §2.4: "Implementations MUST prohibit the execution of more than
    // one reject in a Sieve script." A second one is not executed: the first
    // stands, refusing the message as the second would. strictReject makes it
    // an error instead, as in Pigeonhole: a throw fails the whole script, and
    // inside a foreverypart loop a message decides how many rejects run.
    if (d.rejected) {
      if (d.script.opts.strictReject) throw new SieveError("reject: more than one reject/ereject action");
      return;
    }
    d.rejected = true;
    d.rejectReason = expandVars(d, this.reason);
    d.rejectExtended = this.extended;
    d.implicitKeep = false;
  }
}

/**
 * RFC 5429 §2.4, enforced once the script has run so the order of the actions
 * does not matter: reject MUST NOT be combined with vacation, and — as in
 * Pigeonhole and go-sieve — not with any action that delivers the message
 * (keep, fileinto, redirect; `:copy` included), which the RFC calls NOT
 * RECOMMENDED. discard and flags are not deliveries.
 *
 * A conflict is disclosed as indeterminate, and the host refuses the reject as
 * it refuses a discard on an indeterminate run, while the delivering actions
 * stand. It is not thrown: the message picks the branches that reach one, and
 * a throw fails the whole script, which a host that fails open turns into
 * every rule skipped. `strict` (strictReject, and the testsuite) throws, as
 * Pigeonhole does.
 */
export function checkRejectConflicts(d: RuntimeData, strict = d.script.opts.strictReject): void {
  if (!d.rejected) return;
  let conflict = "";
  if (d.keep) conflict = "keep";
  else if (d.mailboxes.length > 0) conflict = "fileinto";
  else if (d.redirectAddr.length > 0) conflict = "redirect";
  else if (d.vacationRan) conflict = "vacation";
  else return;
  if (strict) throw new SieveError(`reject/ereject action conflicts with the ${conflict} action`);
  d.indeterminate = true;
}
