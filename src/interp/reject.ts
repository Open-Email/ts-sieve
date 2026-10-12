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
import { onGuess, type Cmd, type RuntimeData } from "./runtime.js";
import { expandVars } from "./variables.js";

/** Whether a reject conflict is an error: under strictReject, and in the
 * testsuite, which runs Pigeonhole's tests and expects its errors. */
function strictFor(d: RuntimeData): boolean {
  return d.script.opts.strictReject || d.script.requiresExtension("vnd.dovecot.testsuite");
}

export class CmdReject implements Cmd {
  reason = "";

  constructor(readonly extended: boolean) {}

  execute(d: RuntimeData): void {
    // Expanded first: in a loop the expansion is charged and may run out of
    // the loop's share, and the command must then have done nothing.
    const reason = expandVars(d, this.reason);
    // RFC 5429 §2.4: "Implementations MUST prohibit the execution of more than
    // one reject in a Sieve script." A second one is not executed: the first
    // stands, refusing the message as the second would, and is never turned
    // into the other kind (§2.3). strictReject makes it an error instead, as in
    // Pigeonhole: a throw fails the whole script, and inside a foreverypart
    // loop a message decides how many rejects run.
    if (d.rejected) {
      if (strictFor(d)) throw new SieveError("reject: more than one reject/ereject action");
      return;
    }
    d.rejected = true;
    d.rejectExecutionProven = !onGuess(d);
    d.rejectOnGuess ||= !d.rejectExecutionProven;
    d.rejectReason = reason;
    d.rejectExtended = this.extended;
    // The implicit keep is cancelled once the script has run, and only if the
    // reject stands (checkRejectConflicts): a reject refused for a conflict
    // must not take with it the keep a :copy asked for.
  }
}

/**
 * RFC 5429 §2.4, enforced once the script has run so the order of the actions
 * does not matter: reject MUST NOT be combined with vacation, and — as in
 * Pigeonhole and go-sieve — not with any action that delivers the message
 * (keep, fileinto, redirect; `:copy` included), which the RFC calls NOT
 * RECOMMENDED. discard and flags are not deliveries.
 *
 * A reject that stands cancels the implicit keep (§2.1). A conflict is not
 * thrown: the message picks the branches that reach one, and a throw fails
 * the whole script, which a host that fails open turns into every rule
 * skipped. It is named in rejectConflict and disclosed as indeterminate, and
 * everything else stands as if the reject had not run: the host refuses the
 * reject, as it refuses a discard on an indeterminate run. `strict`
 * (strictReject, and the testsuite) throws, as Pigeonhole does.
 * A redirect dropped for an incomplete address may have delivered with the
 * whole input: conservatively name that possible conflict too (#81).
 */
export function checkRejectConflicts(d: RuntimeData, strict = strictFor(d)): void {
  if (!d.rejected) return;
  let conflict: RuntimeData["rejectConflict"];
  if (d.keep) conflict = "keep";
  else if (d.mailboxes.length > 0) conflict = "fileinto";
  else if (d.redirectAddr.length > 0 || d.redirectUnresolved) conflict = "redirect";
  else if (d.vacationRan) conflict = "vacation";
  else {
    d.implicitKeep = false;
    return;
  }
  if (strict) throw new SieveError(`reject/ereject action conflicts with the ${conflict} action`);
  d.rejectConflict = conflict;
  d.indeterminate = true;
}
