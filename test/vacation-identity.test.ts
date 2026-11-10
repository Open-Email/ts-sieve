// RFC 5230 §4.2: a vacation response is tracked by its :handle, or, when the
// script gives none, by its :subject, :from, :mime and reason arguments, all
// as written in the script (before variable expansion). The expanded fields
// cannot serve: two responses that differ only in a variable's value are one
// response, and an explicit empty :handle is not an omitted one. So the result
// carries an opaque responseIdentity, the same key migadu/go-sieve exposes as
// VacationResponse.ResponseIdentity (migadu/go-sieve#6).

import { describe, expect, it } from "vitest";
import { DummyPolicy, EnvelopeStatic, load, MessageStatic, newRuntimeData, type VacationResponse } from "../src/index.js";
import { parseEml, parts } from "./harness.js";

function respond(script: string): VacationResponse {
  const s = load(`require ["vacation", "variables"]; ${script}`, { enabledExtensions: ["vacation", "variables"] });
  const d = newRuntimeData(s, new DummyPolicy(), new EnvelopeStatic("sender@example.com", "owner@example.com"), new MessageStatic(0, new Map()));
  s.execute(d);
  const r = d.vacationResponses.get("sender@example.com");
  if (r === undefined) throw new Error("no vacation response");
  return r;
}

function identity(script: string): string {
  const id = (respond(script) as { responseIdentity?: unknown }).responseIdentity;
  expect(typeof id === "string" && id !== "", "vacation result has no response identity").toBe(true);
  return id as string;
}

describe("vacation response identity (RFC 5230 §4.2)", () => {
  // migadu/go-sieve tests/vacation_identity_test.go, case for case.
  const cases: [name: string, a: string, b: string, same: boolean][] = [
    ["same implicit response", `vacation "Away";`, `vacation "Away";`, true],
    ["different reason", `vacation "Away";`, `vacation "Contact support";`, false],
    ["different subject", `vacation :subject "A" "Away";`, `vacation :subject "B" "Away";`, false],
    ["different from", `vacation :from "a@example.com" "Away";`, `vacation :from "b@example.com" "Away";`, false],
    ["different MIME", `vacation "Away";`, `vacation :mime "Away";`, false],
    ["tuple boundary", `vacation :subject "ab" :from "c" "Away";`, `vacation :subject "a" :from "bc" "Away";`, false],
    ["period and addresses do not change identity", `vacation :days 1 "Away";`, `vacation :days 30 :addresses "alias@example.com" "Away";`, true],
    ["same explicit handle", `vacation :handle "away" "A";`, `vacation :handle "away" :mime :subject "B" "C";`, true],
    ["different explicit handles", `vacation :handle "one" "Away";`, `vacation :handle "two" "Away";`, false],
    ["empty explicit handle", `vacation :handle "" "A";`, `vacation :handle "" "B";`, true],
    ["empty handle distinct from omitted", `vacation :handle "" "Away";`, `vacation "Away";`, false],
    [
      "unexpanded implicit tuple",
      `set "name" "Alice"; vacation :subject "\${name}" :from "\${name}@example.com" "Away \${name}";`,
      `set "name" "Bob"; vacation :subject "\${name}" :from "\${name}@example.com" "Away \${name}";`,
      true,
    ],
    [
      "unexpanded explicit handle",
      `set "name" "Alice"; vacation :handle "\${name}" "Away";`,
      `set "name" "Bob"; vacation :handle "\${name}" "Away";`,
      true,
    ],
  ];
  for (const [name, a, b, same] of cases) {
    it(name, () => {
      expect(identity(a) === identity(b)).toBe(same);
    });
  }

  it("the rendered fields still expand", () => {
    const r = respond(`set "name" "Alice"; vacation :subject "Hello \${name}" :handle "\${name}" "Away \${name}";`);
    expect([r.subject, r.handle, r.body]).toEqual(["Hello Alice", "Alice", "Away Alice"]);
  });

  it("an explicit handle cannot collide with a synthesized key", () => {
    // The two domains are prefixed apart, so a handle spelled like a tuple
    // never names the tuple's response.
    expect(identity(`vacation :handle "Away" "Away";`).startsWith("v1:h:")).toBe(true);
    expect(identity(`vacation "Away";`).startsWith("v1:r:")).toBe(true);
  });

  it("a non-ASCII reason is part of the identity", () => {
    expect(identity(`vacation "Réponse 🏖";`)).not.toBe(identity(`vacation "Reponse 🏖";`));
  });

  it("the same response executed once per part keeps one identity", () => {
    const s = load(`require ["vacation", "foreverypart", "mime"]; foreverypart { vacation "Away"; }`, {
      enabledExtensions: ["vacation", "foreverypart", "mime"],
    });
    const { headers, size, body } = parseEml(parts(3));
    const d = newRuntimeData(s, new DummyPolicy(), new EnvelopeStatic("sender@example.com", "owner@example.com"), new MessageStatic(size, headers, body));
    s.execute(d);
    const r = d.vacationResponses.get("sender@example.com") as { responseIdentity?: unknown } | undefined;
    expect(r?.responseIdentity).toBe(identity(`vacation "Away";`));
  });

  // Identities migadu/go-sieve at 031259f returns for the same scripts. The
  // key is opaque, but one script on two engines naming two responses would
  // let a mailbox moved between them answer a sender twice; these pin the
  // SHA-256 framing (8-byte big-endian length before each UTF-8 argument) and
  // the lexer's reading of each argument.
  const golden: [script: string, id: string][] = [
    [`vacation "Away";`, "v1:r:a39585b336bbc917d9e3255bb6d7a98f0954405c17c42d745a1937fd67bb4beb"],
    [`vacation :subject "ab" :from "c" "Away";`, "v1:r:07e3b4460a9ef1f7e982891011fb866dd262fb81349c803fe6781b95681504ad"],
    [`vacation :mime "Away";`, "v1:r:0a1cfdcd0235da45df40304f3f0dea61ba9c2d5331afed8633aade592f25f226"],
    [`vacation :handle "away" "A";`, "v1:h:2478d85065bcf563c04fcac130cbedb96924875c6db20bde13edeb8de18be9bc"],
    [`vacation :handle "" "A";`, "v1:h:af5570f5a1810b7af78caf4bc70a660f0df51e42baf91d4de5b2328de0e83dfc"],
    [
      `vacation :days 30 :addresses "alias@example.com" :subject "Hello \${name}" :from "\${name}@example.com" "Away \${name}";`,
      "v1:r:cc9df809281fd689f2260b2deb07b1a32a3f8d3209acda8a12cdd2bba021ccda",
    ],
    [`vacation :subject "Café ✈ 日本" "Réponse 🏖";`, "v1:r:f92a805038cfa3f4ca26efcac93f89a43ead82919381cced7c04d15c6764d162"],
    ["vacation text:\nAway\n..dot-stuffed\n.\n;", "v1:r:b0ea73c1eec971b76b68a00f2676552fb337730d8f5b5b8d1ee89006388d2ffd"],
  ];
  for (const [script, id] of golden) {
    it(`matches go-sieve for ${JSON.stringify(script)}`, () => {
      expect(identity(script)).toBe(id);
    });
  }
});
