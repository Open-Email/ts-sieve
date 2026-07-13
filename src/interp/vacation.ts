// RFC 5230 vacation.
//
// vacation is deliberately PARTIAL: it records the intended response
// on RuntimeData.vacationResponses (keyed by envelope-from) and leaves the actual
// send + dedup/rate-limit + RFC 5230 §4.5 loop-prevention to the HOST. The only
// in-library loop check is the `:addresses` "is this my own address?" test. An
// empty envelope-from is a hard error (aborts the script), not a silent skip.

import { SieveError } from "../errors.js";
import type { Cmd, RuntimeData } from "./runtime.js";
import { expandVars, expandVarsList } from "./variables.js";

export interface VacationResponse {
  from: string;
  subject: string;
  body: string;
  isMime: boolean;
  handle: string;
  days: number;
}

export class CmdVacation implements Cmd {
  days = 7; // RFC 5230 default
  subject = "";
  from = "";
  addresses: string[] = [];
  mime = false;
  handle = "";
  reason = "";

  execute(d: RuntimeData): void {
    let subject = expandVars(d, this.subject);
    if (subject === "") subject = "Automated reply";
    const from = expandVars(d, this.from);
    const reason = expandVars(d, this.reason);
    const handle = expandVars(d, this.handle);
    const addresses = expandVarsList(d, this.addresses);

    const sender = d.envelope.envelopeFrom();
    if (sender === "") throw new SieveError("vacation: failed to get sender from envelope");

    // Don't autorespond to our own addresses (raw string equality).
    for (const addr of addresses) {
      if (addr === sender) return;
    }

    // Record intent (last-write-wins). The host applies the actual send + dedup.
    // vacation does NOT cancel the implicit keep (RFC 5230 §4).
    d.vacationResponses.set(sender, { from, subject, body: reason, isMime: this.mime, handle, days: this.days });
  }
}
