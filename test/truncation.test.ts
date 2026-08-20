// Three-valued (Kleene) evaluation over truncated inputs.
//
// A comparison whose input is a PREFIX of the real value — the host's body
// read window cut it, or the engine's own maxMatchInputLength did — cannot
// always answer. The engine answers `true`/`false` only when the result is
// PROVABLE from the prefix, and `"unknown"` otherwise; `not`/`allof`/`anyof`
// propagate unknown per Kleene logic. A branch (`if`/`elsif`) whose condition
// is unknown is NOT TAKEN — an unproven condition must not fire its actions,
// which is what used to let a `not`-guarded test invert on bytes the engine
// never read — and the guess is disclosed on `indeterminate`, so the host can
// refuse the execution's irreversible outcomes. Not-taken rather than abort,
// deliberately: an abort fails the whole script open, so one undecidable body
// glob would stop every unrelated rule from applying.
//
// Soundness rules per match type over a prefix P of the real value R:
//   :contains  found in P → TRUE; not found → unknown (may sit past the cut)
//   :is        unknown iff fold(key) startsWith fold(P) (R may extend P);
//              definite FALSE otherwise; numeric comparator → unknown
//   :matches   whole-input semantics: a match is TRUE only when the pattern
//              ends with an unescaped `*` (the star absorbs the unread tail);
//              anything else — including no match — is unknown
//   :regex     search semantics: found → TRUE unless the pattern contains `$`;
//              not found → unknown
//   :value     unknown (a prefix cannot order against a key)
//   :count     a structurally cut body's part count is a LOWER BOUND: `ge`/`gt`
//              already proven stay proven, everything else is unknown; a cut
//              inside a single LEAF leaves the count exact

import { describe, expect, it } from "vitest";
import { R, run } from "./harness.js";

const EML = ["From: a@x", "To: b@y", "Subject: hi", "", "hello world"].join("\r\n");

const CUT = { bodyTruncated: true };

describe("truncated body (read-window prefix)", () => {
  it("a not-guarded :contains over a truncated body is not taken, never inverted", () => {
    // The defect this exists for: "tok" may sit past the cut, so `not body
    // :contains "tok"` must not evaluate to true and file/discard on it.
    const r = run('require ["body","fileinto"]; if not body :contains "tok" { fileinto "X"; }', EML, CUT);
    expect(r).toEqual(R({ implicitKeep: true, indeterminate: true }));
  });

  it(":contains found in the prefix is definite true — filtering still works on big mail", () => {
    const r = run('require ["body","fileinto"]; if body :contains "hello" { fileinto "X"; }', EML, CUT);
    expect(r).toEqual(R({ fileinto: ["X"] }));
  });

  it(":matches with a trailing star that matched is definite true", () => {
    const r = run('require ["body","fileinto"]; if body :matches "*hello*" { fileinto "X"; }', EML, CUT);
    expect(r).toEqual(R({ fileinto: ["X"] }));
  });

  it(":matches without a trailing star is indeterminate even when the prefix matched", () => {
    // "*world" matched the prefix exactly at its end — but R extends P, so the
    // whole-input match is undecidable.
    const r = run('require ["body","fileinto"]; if body :matches "*world" { fileinto "X"; }', EML, CUT);
    expect(r).toEqual(R({ implicitKeep: true, indeterminate: true }));
  });

  it(":is against a key the prefix cannot extend into is definite false", () => {
    // fold(key) does not start with fold(prefix) → R can never equal key.
    const r = run('require ["body","fileinto"]; if not body :is "zzz" { fileinto "X"; }', EML, CUT);
    expect(r).toEqual(R({ fileinto: ["X"] }));
  });

  it(":is against a key extending the prefix is indeterminate", () => {
    const r = run('require ["body","fileinto"]; if body :is "hello world" { fileinto "X"; }', EML, CUT);
    expect(r).toEqual(R({ implicitKeep: true, indeterminate: true }));
  });

  it(":regex found without an end anchor is definite true; not found is indeterminate", () => {
    const found = run('require ["body","fileinto","regex"]; if body :regex "hel+o" { fileinto "X"; }', EML, CUT);
    expect(found).toEqual(R({ fileinto: ["X"] }));
    const missed = run(
      'require ["body","fileinto","regex"]; if not body :regex "xyz9+" { fileinto "X"; }',
      EML,
      CUT,
    );
    expect(missed).toEqual(R({ implicitKeep: true, indeterminate: true }));
  });

  it(":regex with an end anchor is indeterminate even when the prefix matched", () => {
    const r = run('require ["body","fileinto","regex"]; if body :regex "world$" { fileinto "X"; }', EML, CUT);
    expect(r).toEqual(R({ implicitKeep: true, indeterminate: true }));
  });

  it("a match inside a boundary-delimited (complete) part is sound even without a trailing star", () => {
    // Part 1 ends at a FOUND boundary, so it is complete — ":matches" over it
    // keeps ordinary semantics even though the body as a whole was cut inside
    // part 2.
    const eml = [
      "From: a@x",
      "To: b@y",
      'Content-Type: multipart/mixed; boundary="bnd"',
      "",
      "--bnd",
      "Content-Type: text/plain",
      "",
      "abcxyz",
      "--bnd",
      "Content-Type: text/plain",
      "",
      "this part was cut mid-",
    ].join("\r\n");
    const r = run('require ["body","fileinto"]; if body :matches "*xyz" { fileinto "X"; }', eml, CUT);
    expect(r).toEqual(R({ fileinto: ["X"] }));
  });

  it("an indeterminate rule does not stop later rules from applying", () => {
    // The whole point of not-taken over abort: the undecidable body rule
    // quietly does not fire, the decidable header rule still does.
    const r = run(
      'require ["body","fileinto"]; if body :contains "absent" { fileinto "Bulk"; } if header :is "subject" "hi" { fileinto "Important"; }',
      EML,
      CUT,
    );
    expect(r).toEqual(R({ fileinto: ["Important"], indeterminate: true }));
  });

  it("untruncated evaluation is unchanged", () => {
    const r = run('require ["body","fileinto"]; if not body :contains "tok" { fileinto "X"; }', EML);
    expect(r).toEqual(R({ fileinto: ["X"] }));
  });
});

describe("Kleene propagation", () => {
  it("anyof: a definite true absorbs an unknown, in either order", () => {
    const first = run(
      'require ["body","fileinto"]; if anyof (body :contains "hello", body :contains "absent") { fileinto "X"; }',
      EML,
      CUT,
    );
    expect(first).toEqual(R({ fileinto: ["X"] }));
    const second = run(
      'require ["body","fileinto"]; if anyof (body :contains "absent", header :is "subject" "hi") { fileinto "X"; }',
      EML,
      CUT,
    );
    expect(second).toEqual(R({ fileinto: ["X"] }));
  });

  it("allof: a definite false absorbs an unknown, in either order", () => {
    const first = run(
      'require ["body","fileinto"]; if allof (header :is "subject" "nope", body :contains "absent") { discard; }',
      EML,
      CUT,
    );
    expect(first).toEqual(R({ implicitKeep: true }));
    const second = run(
      'require ["body","fileinto"]; if not allof (body :contains "absent", false) { fileinto "X"; }',
      EML,
      CUT,
    );
    expect(second).toEqual(R({ fileinto: ["X"] }));
  });

  it("anyof of only unknowns and falses is unknown — branch not taken, disclosed", () => {
    const r = run(
      'require ["body","fileinto"]; if anyof (body :contains "absent", false) { fileinto "X"; }',
      EML,
      CUT,
    );
    expect(r).toEqual(R({ implicitKeep: true, indeterminate: true }));
  });

  it("elsif with an unknown condition is not taken and disclosed too", () => {
    const r = run(
      'require ["body","fileinto"]; if header :is "subject" "nope" { fileinto "A"; } elsif body :contains "absent" { fileinto "B"; }',
      EML,
      CUT,
    );
    expect(r).toEqual(R({ implicitKeep: true, indeterminate: true }));
  });
});

describe("engine match-input cap (per-comparison prefix)", () => {
  // A 20 KB header value against a 16 KiB cap: the comparison sees a prefix of
  // a COMPLETE value — the same three-valued rules apply.
  const BIG = "x".repeat(20 * 1024);
  const CAP = { options: { maxMatchInputLength: 16 * 1024 } };
  const bigHeaderEml = (value: string) => ["From: a@x", "To: b@y", `X-Big: ${value}`, "", "body"].join("\r\n");

  it("a not-guarded :matches over a capped header is not taken, never inverted", () => {
    const r = run(
      'require ["fileinto"]; if not header :matches "x-big" "*tok*" { fileinto "X"; }',
      bigHeaderEml(BIG),
      CAP,
    );
    expect(r).toEqual(R({ implicitKeep: true, indeterminate: true }));
  });

  it("a trailing-star :matches that matched inside the cap is definite true", () => {
    const r = run(
      'require ["fileinto"]; if header :matches "x-big" "*tok*" { fileinto "X"; }',
      bigHeaderEml(`tok${BIG}`),
      CAP,
    );
    expect(r).toEqual(R({ fileinto: ["X"] }));
  });

  it("headers under the cap keep exact semantics", () => {
    const r = run('require ["fileinto"]; if not header :matches "subject" "*tok*" { fileinto "X"; }', EML, CAP);
    expect(r).toEqual(R({ fileinto: ["X"] }));
  });

  it(":contains is never capped — a giant header still answers exactly", () => {
    // testString has no input cap: only :matches/:regex route through the
    // engine. A definite answer over the full value must stay definite.
    const r = run(
      'require ["fileinto"]; if header :contains "x-big" "tok" { fileinto "X"; }',
      bigHeaderEml(`${BIG}tok`),
      CAP,
    );
    expect(r).toEqual(R({ fileinto: ["X"] }));
  });
});

describe("relational and count over truncated input", () => {
  it(":value over a truncated body is indeterminate", () => {
    const r = run(
      'require ["body","fileinto","relational"]; if body :value "ge" "a" { fileinto "X"; }',
      EML,
      CUT,
    );
    expect(r).toEqual(R({ implicitKeep: true, indeterminate: true }));
  });

  // A multipart cut BEFORE its closing marker: whole sibling parts may hide
  // past the cut, so the visible part count is only a lower bound. (A cut that
  // falls inside a single LEAF leaves the count exact — the tail extends a
  // part, it does not add one — so these pin the multipart shape.)
  const CUT_MULTIPART = [
    "From: a@x",
    "To: b@y",
    'Content-Type: multipart/mixed; boundary="bnd"',
    "",
    "--bnd",
    "Content-Type: text/plain",
    "",
    "first part, cut mid-",
  ].join("\r\n");

  it(":count ge that already holds on the visible parts is definite true", () => {
    const r = run(
      'require ["body","fileinto","relational","comparator-i;ascii-numeric"]; if body :count "ge" :comparator "i;ascii-numeric" "1" { fileinto "X"; }',
      CUT_MULTIPART,
      CUT,
    );
    expect(r).toEqual(R({ fileinto: ["X"] }));
  });

  it(":count eq over a structurally cut body is indeterminate", () => {
    const r = run(
      'require ["body","fileinto","relational","comparator-i;ascii-numeric"]; if body :count "eq" :comparator "i;ascii-numeric" "1" { fileinto "X"; }',
      CUT_MULTIPART,
      CUT,
    );
    expect(r).toEqual(R({ implicitKeep: true, indeterminate: true }));
  });

  it(":count over a cut single leaf stays exact — one part however long its tail", () => {
    const r = run(
      'require ["body","fileinto","relational","comparator-i;ascii-numeric"]; if body :count "eq" :comparator "i;ascii-numeric" "1" { fileinto "X"; }',
      EML,
      CUT,
    );
    expect(r).toEqual(R({ fileinto: ["X"] }));
  });
});

describe("comparator arms of prefix semantics", () => {
  it(":is under i;octet — case difference is definite false, exact extension is unknown", () => {
    // Octet folding is identity, so "Hello world" can never be the value whose
    // prefix is "hello world" — definite false even truncated.
    const no = run('require ["body","fileinto"]; if not body :comparator "i;octet" :is "Hello world" { fileinto "X"; }', EML, CUT);
    expect(no).toEqual(R({ fileinto: ["X"] }));
    // "hello worldwide" extends the prefix byte-for-byte — undecidable.
    const maybe = run('require ["body","fileinto"]; if body :comparator "i;octet" :is "hello worldwide" { fileinto "X"; }', EML, CUT);
    expect(maybe).toEqual(R({ implicitKeep: true, indeterminate: true }));
  });

  it(":is under i;unicode-casemap folds before the prefix test", () => {
    const r = run(
      'require ["body","fileinto","comparator-i;unicode-casemap"]; if body :comparator "i;unicode-casemap" :is "HELLO WORLD extra" { fileinto "X"; }',
      EML,
      CUT,
    );
    expect(r).toEqual(R({ implicitKeep: true, indeterminate: true }));
  });

  it(":is under i;ascii-numeric over a truncated input is always unknown", () => {
    // The leading digit run may extend past the cut, so no numeric comparison
    // over a prefix is provable.
    const r = run(
      'require ["body","fileinto","comparator-i;ascii-numeric"]; if body :comparator "i;ascii-numeric" :is "42" { fileinto "X"; }',
      EML,
      CUT,
    );
    expect(r).toEqual(R({ implicitKeep: true, indeterminate: true }));
  });
});

describe("variable-bearing patterns decide soundness per run", () => {
  // A ${...} key cannot precompile, so the sound-on-prefix decision is made
  // from the EXPANDED pattern at match time — these pin that arm.
  it(":matches with an expanded trailing star that matched is definite true", () => {
    const r = run(
      'require ["body","fileinto","variables"]; set "t" "hello"; if body :matches "*${t}*" { fileinto "X"; }',
      EML,
      CUT,
    );
    expect(r).toEqual(R({ fileinto: ["X"] }));
  });

  it(":matches with an expanded pattern NOT ending in a star is unknown on a match", () => {
    const r = run(
      'require ["body","fileinto","variables"]; set "t" "world"; if body :matches "*${t}" { fileinto "X"; }',
      EML,
      CUT,
    );
    expect(r).toEqual(R({ implicitKeep: true, indeterminate: true }));
  });

  it(":regex with an expanded pattern compiles per run and keeps the $-rule", () => {
    const found = run(
      'require ["body","fileinto","variables","regex"]; set "p" "hel+o"; if body :regex "${p}" { fileinto "X"; }',
      EML,
      CUT,
    );
    expect(found).toEqual(R({ fileinto: ["X"] }));
    const anchored = run(
      'require ["body","fileinto","variables","regex"]; set "p" "world$"; if body :regex "${p}" { fileinto "X"; }',
      EML,
      CUT,
    );
    expect(anchored).toEqual(R({ implicitKeep: true, indeterminate: true }));
  });
});

describe("cut leaves that fail to decode", () => {
  // base64 cut to length % 4 == 1 is undecodable at the ragged edge: atob
  // throws. Under a cut that is "content unknown"; untruncated it stays the
  // script error the host's fail-open handles.
  const B64_EML = [
    "From: a@x",
    "To: b@y",
    "Subject: hi",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    "aGVsbG8gd",
  ].join("\r\n");

  it("a cut, undecodable base64 leaf is unknown — branch not taken, disclosed", () => {
    const r = run('require ["body","fileinto"]; if not body :contains "tok" { fileinto "X"; }', B64_EML, CUT);
    expect(r).toEqual(R({ implicitKeep: true, indeterminate: true }));
  });

  it("an untruncated undecodable base64 leaf still throws (host fail-open)", () => {
    expect(() =>
      run('require ["body","fileinto"]; if body :contains "tok" { fileinto "X"; }', B64_EML),
    ).toThrow();
  });
});

describe("branch mechanics", () => {
  it("an elsif whose condition is definite true executes its block", () => {
    const r = run(
      'require ["fileinto"]; if header :is "subject" "nope" { fileinto "A"; } elsif header :is "subject" "hi" { fileinto "B"; }',
      EML,
    );
    expect(r).toEqual(R({ fileinto: ["B"] }));
  });
});
