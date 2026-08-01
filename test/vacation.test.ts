// Vacation conformance tests — asserts on RuntimeData.vacationResponses
// (the library records intent; the host does the actual send/dedup).

import { describe, expect, it } from "vitest";
import { DummyPolicy, EnvelopeStatic, load, MessageStatic, newRuntimeData, type RuntimeData } from "../src/index.js";

function runVac(script: string, envFrom: string): RuntimeData {
  const s = load(script, { enabledExtensions: ["vacation", "variables"] });
  const d = newRuntimeData(s, new DummyPolicy(), new EnvelopeStatic(envFrom, "recipient@example.com"), new MessageStatic(0, new Map()));
  s.execute(d);
  return d;
}

describe("vacation", () => {
  it("BasicVacation", () => {
    const d = runVac(`require ["vacation"]; vacation "I'm on vacation.";`, "sender@example.com");
    expect(d.vacationResponses.size).toBe(1);
    const r = d.vacationResponses.get("sender@example.com")!;
    // "" = the script set no :subject. The host substitutes RFC 5230 §5.4's
    // "Auto: <original subject>", which needs a header the library never sees.
    expect(r.subject).toBe("");
    expect(r.body).toBe("I'm on vacation.");
    expect(r.from).toBe("");
    expect(r.handle).toBe("");
    expect(r.days).toBe(7);
  });

  it("VacationWithParameters", () => {
    const d = runVac(
      `require ["vacation"]; vacation :days 14 :subject "Out of Office" :from "me@example.com" :addresses ["me@example.com", "me2@example.com"] :handle "vacation-001" "I'm on vacation until next week.";`,
      "sender@example.com",
    );
    expect(d.vacationResponses.size).toBe(1);
    const r = d.vacationResponses.get("sender@example.com")!;
    expect(r.subject).toBe("Out of Office");
    expect(r.body).toBe("I'm on vacation until next week.");
    expect(r.from).toBe("me@example.com");
    expect(r.handle).toBe("vacation-001");
    expect(r.days).toBe(14);
    expect(r.isMime).toBe(false);
  });

  it("NoVacationResponseToOwnAddresses", () => {
    const d = runVac(
      `require ["vacation"]; vacation :addresses ["sender@example.com", "other@example.com"] "Away.";`,
      "sender@example.com",
    );
    expect(d.vacationResponses.size).toBe(0);
  });

  it("a null envelope sender records nothing and does NOT abort the script", () => {
    // RFC 5230 §4.6: never autorespond to a bounce/autoresponder. Recording
    // nothing is the whole effect — the script keeps running, so the actions
    // AFTER the vacation command still apply. Throwing here used to destroy
    // them on any host that fails open over script errors.
    const s = load(`require ["vacation", "fileinto"]; vacation "Away."; fileinto "Archive";`, {
      enabledExtensions: ["vacation", "fileinto"],
    });
    const d = newRuntimeData(
      s,
      new DummyPolicy(),
      new EnvelopeStatic("", "recipient@example.com"),
      new MessageStatic(0, new Map()),
    );
    expect(() => s.execute(d)).not.toThrow();
    expect(d.vacationResponses.size).toBe(0);
    expect(d.mailboxes).toEqual(["Archive"]);
  });

  it(":mime flag is recorded; require gate; :seconds rejected", () => {
    const d = runVac(`require ["vacation"]; vacation :mime "reply";`, "s@x.com");
    expect(d.vacationResponses.get("s@x.com")!.isMime).toBe(true);
    expect(() => runVac(`vacation "x";`, "s@x.com")).toThrow();
    expect(() => runVac(`require ["vacation"]; vacation :seconds 3600 "x";`, "s@x.com")).toThrow();
  });
});
