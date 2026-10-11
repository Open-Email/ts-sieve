// RFC 5230 vacation.
//
// vacation is deliberately PARTIAL: it records the intended response
// on RuntimeData.vacationResponses (keyed by envelope-from) and leaves the actual
// send + dedup/rate-limit + RFC 5230 §4.5 loop-prevention to the HOST. The only
// in-library loop check is the `:addresses` "is this my own address?" test.
//
// Two things this command deliberately does NOT do, because only the host can:
// an empty envelope-from records nothing and lets the script continue (a
// bounce/DSN is exactly the mail RFC 5230 §4.6 forbids answering, and aborting
// the run over it would discard every OTHER action the script asked for), and
// an unset `:subject` is recorded as "" rather than an invented default —
// RFC 5230 §5.4 wants "Auto: <original subject>", and the original subject is a
// header only the host has.

import { type Cmd, onGuess, type RuntimeData } from "./runtime.js";
import { expandVars, expandVarsList } from "./variables.js";

export interface VacationResponse {
  from: string;
  subject: string;
  body: string;
  isMime: boolean;
  handle: string;
  days: number;
  /**
   * The expanded `:addresses` list.
   *
   * Recorded because the library can only apply HALF of what RFC 5230 uses it
   * for: it knows these addresses are the user's for the "is the sender me?"
   * check above, but the §4.5 test — reply only if one of the user's addresses
   * is an actual To/Cc recipient — needs the message headers, which only the
   * host reads. Dropping it would silently deny auto-replies to anyone writing
   * to a secondary address the script explicitly claimed.
   */
  addresses: string[];
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
    // "" = unset; the host applies the RFC 5230 §5.4 default it can compute.
    // Expanded first: in a loop an expansion is charged and may run out of
    // the loop's share, and then the command must have done nothing.
    const subject = expandVars(d, this.subject);
    const from = expandVars(d, this.from);
    const reason = expandVars(d, this.reason);
    const handle = expandVars(d, this.handle);
    const addresses = expandVarsList(d, this.addresses);
    // In a loop, a step per address it compares: a literal list costs no
    // expansion, and it may hold thousands.
    if (d.budget.shares > 0) d.budget.consume(1 + addresses.length);
    // RFC 5429 §2.4: vacation conflicts with reject whether or not it records
    // a response (a null sender or one of :addresses records none).
    d.vacationRan = true;

    // A null envelope sender (MAIL FROM:<>) is a bounce or another
    // autoresponder — RFC 5230 §4.6 says never answer it. Record nothing and
    // let the rest of the script run: the alternative (throwing) would abort
    // the whole run, and a host that fails open on script errors would then
    // silently lose the fileinto/flags this same script asked for.
    const sender = d.envelope.envelopeFrom();
    if (sender === "") return;

    // Don't autorespond to our own addresses (raw string equality).
    for (const addr of addresses) {
      if (addr === sender) return;
    }

    // Record intent (last-write-wins). The host applies the actual send + dedup.
    // vacation does NOT cancel the implicit keep (RFC 5230 §4).
    // On a guess only while every vacation that recorded one ran on a guess.
    d.vacationOnGuess = (d.vacationResponses.size === 0 || d.vacationOnGuess) && onGuess(d);
    d.vacationResponses.set(sender, {
      from,
      subject,
      body: reason,
      isMime: this.mime,
      handle,
      days: this.days,
      addresses,
    });
  }
}
