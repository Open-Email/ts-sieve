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

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { type Cmd, onGuess, type RuntimeData } from "./runtime.js";
import { expandMarked } from "./variables.js";

const encoder = new TextEncoder();

export interface VacationResponse {
  from: string;
  subject: string;
  body: string;
  isMime: boolean;
  handle: string;
  /**
   * An opaque, stable key for RFC 5230 §4.2 response tracking: the host's
   * "have I answered this sender with THIS response within :days?" record.
   * It is the explicit `:handle`, or, when the script gives none, the
   * `:subject`, `:from`, `:mime` and reason arguments, all as written in the
   * script, before variable expansion: a response whose text names a variable
   * is one response whatever the variable holds, and an explicit empty handle
   * is a handle, distinct from an omitted one. `:days` and `:addresses` are
   * not part of it. The fields above stay expanded, for sending.
   *
   * migadu/go-sieve computes the same key for the same script
   * (`VacationResponse.ResponseIdentity`), so a mailbox moved between the two
   * engines keeps its record.
   */
  responseIdentity: string;
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
  /** Whether the script gave `:handle` at all: `:handle ""` is a handle. */
  handleSet = false;
  reason = "";
  private identity: string | undefined;

  execute(d: RuntimeData): void {
    // "" = unset; the host applies the RFC 5230 §5.4 default it can compute.
    // Expanded first: in a loop an expansion is charged and may run out of
    // the loop's share, and then the command must have done nothing.
    // A response built from a value the engine could not hold whole (see
    // Mark) is not the whole input's: its text, its handle or whether it is
    // recorded at all (an :addresses entry compared with the sender) may
    // differ, so it is on a guess.
    let marked = false;
    const x = (s: string): string => {
      const { value, mark } = expandMarked(d, s);
      if (mark !== "") marked = true;
      return value;
    };
    const subject = x(this.subject);
    const from = x(this.from);
    const reason = x(this.reason);
    const handle = x(this.handle);
    // Whether each :addresses entry is marked: one in doubt that equals the
    // sender records nothing here, though whole it may not equal it.
    const addressMarks: boolean[] = [];
    const addresses = d.script.requiresExtension("variables")
      ? this.addresses.map((a) => {
          const before = marked;
          marked = false;
          const v = x(a);
          addressMarks.push(marked);
          marked ||= before;
          return v;
        })
      : this.addresses;
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

    // Don't autorespond to our own addresses (raw string equality). An entry
    // in doubt that matched may not match whole: then this vacation may
    // replace the one recorded, which is a guess.
    for (let i = 0; i < addresses.length; i++) {
      if (addresses[i] !== sender) continue;
      if (addressMarks[i] && d.vacationResponses.size > 0) d.vacationOnGuess = true;
      return;
    }

    // Record intent (last-write-wins). The host applies the actual send + dedup.
    // vacation does NOT cancel the implicit keep (RFC 5230 §4).
    // The last one recorded is the one sent: on a guess when it ran on one.
    d.vacationOnGuess = onGuess(d) || marked;
    d.vacationResponses.set(sender, {
      from,
      subject,
      body: reason,
      isMime: this.mime,
      handle,
      responseIdentity: this.responseIdentity(),
      days: this.days,
      addresses,
    });
  }

  /**
   * VacationResponse.responseIdentity: SHA-256 over each argument's UTF-8
   * bytes, each after its length as an 8-byte big-endian integer, so no two
   * tuples run together ("ab","c" against "a","bc") and an empty argument
   * still counts. "v1:h:" keys an explicit handle and "v1:r:" a synthesized
   * one, so neither can name the other. A lone surrogate, which no UTF-8
   * stored script holds, encodes as U+FFFD.
   *
   * Only the arguments as written go in, so it is computed once per command,
   * whatever runs it: a vacation inside foreverypart hashes its reason once,
   * not once per part.
   */
  responseIdentity(): string {
    if (this.identity !== undefined) return this.identity;
    const explicit = this.handleSet || this.handle !== "";
    const fields = explicit ? [this.handle] : [this.subject, this.from, this.mime ? "1" : "0", this.reason];
    const h = sha256.create();
    for (const f of fields) {
      const b = encoder.encode(f);
      const size = new Uint8Array(8);
      const view = new DataView(size.buffer);
      view.setUint32(0, Math.floor(b.length / 0x100000000));
      view.setUint32(4, b.length >>> 0);
      h.update(size).update(b);
    }
    this.identity = `v1:${explicit ? "h" : "r"}:${bytesToHex(h.digest())}`;
    return this.identity;
  }
}
