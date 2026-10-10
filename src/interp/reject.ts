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
    // one reject in a Sieve script."
    if (d.rejected) throw new SieveError("reject: more than one reject/ereject action");
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
 */
export function checkRejectConflicts(d: RuntimeData): void {
  if (!d.rejected) return;
  let conflict = "";
  if (d.keep) conflict = "keep";
  else if (d.mailboxes.length > 0) conflict = "fileinto";
  else if (d.redirectAddr.length > 0) conflict = "redirect";
  else if (d.vacationRan) conflict = "vacation";
  else return;
  throw new SieveError(`reject/ereject action conflicts with the ${conflict} action`);
}
