// Bounded-regex safety tests: pattern-length caps, input truncation, and match
// bounding for the `:regex` / `:matches` engines.
// Cross-checked against the regex-and-match design notes §4.1–4.2.
//
// NATURE OF THESE TESTS. Several cases describe ENGINE-LEVEL behaviour of the
// bounded matcher: the safe-compile step, the exec-time / pattern-length /
// input-length limits, submatch extraction, the octet/unicode match paths, the
// effective-limit defaulting, and the internal input-size threshold that selects
// the guarded match path. The public API (and this test harness) exposes none of
// that surface directly: it drives whole Sieve scripts via run()/compile() and
// observes the accumulated Result.
//
// So each engine-level case is mapped to the closest OBSERVABLE script-level
// behaviour where one exists, and put under it.skip() with a // TODO where it
// depends on limits / per-execution config that the public API does not expose.
//
// STATUS (why most go RED). The `regex` extension and match-variable captures
// (`variables`) are not implemented in v1, and are NOT in the library's
// `supportedRequires`, so any script that `require`s them is rejected at load —
// the reachable cases below throw RED today. That is intended; they turn green as
// `:regex` and `${N}` captures land.

import { describe, expect, it } from "vitest";
import { compile, R, run } from "./harness.js";

// ---------------------------------------------------------------------------
// Bounded matcher: input truncation, pattern-length caps, guarded match path
// ---------------------------------------------------------------------------
describe("regex bound", () => {
  // Oversized-input truncation
  //   With limits {MaxExecTime: 100ms, MaxPatternLength: 100, MaxInputLength: 8}
  //   and pattern "b$":
  //     match against "aaaaaaaa"+"b" -> truncated to 8 bytes "aaaaaaaa" -> NO match
  //     match against "aaaaaaa"+"b"  -> 8 bytes, within cap -> MATCH
  //
  // TODO(regex): needs a safe-compile step + a custom MaxInputLength of 8.
  // The engine/limits surface is not exported; the harness cannot set a per-matcher
  // input cap. NOTE: the library DOES expose `maxMatchInputLength` (load Options)
  // for the `:matches` glob path — but this case targets the `:regex` engine, and
  // its pattern "b$" is a REGEX anchor, not a glob (as a glob "b$" is the literal
  // chars b,$), so it is not faithfully reproducible via `:matches`.
  it.skip("TruncatesOversizedInput: input past MaxInputLength is truncated (safe degradation)", () => {
    // engine-only; see TODO above.
  });

  // Too-long pattern rejection
  //   With limits {MaxPatternLength: 10, MaxInputLength: 100}, safe-compiling a
  //   pattern of 11 'a's -> compile error.
  //
  // TODO(regex): needs a safe-compile step with a custom MaxPatternLength of 10.
  // Not exposed; the default cap is 1000. The default-cap analogue IS reachable and
  // appears below as "RejectsOversizedPattern".
  it.skip("RejectsTooLongPattern: pattern length 11 > MaxPatternLength 10 fails at compile", () => {
    // engine-only; see TODO above.
  });

  // Oversized glob pattern rejection
  //   Each '*' expands to "(.*?)" (5 chars), so 300 stars > the 1000-char cap.
  //   Compiling a 300-star matcher -> compile error.
  //
  // REACHABLE with the DEFAULT limits (MaxPatternLength 1000): a no-variable
  // `:matches` pattern is precompiled at load time, so a 300-star glob
  // (-> a ~1506-char regex) is rejected as `malformed pattern` during LOAD.
  // COVERAGE GAP: this library implements `:matches` as a linear glob with NO
  // compile-time pattern-length cap, so compile() does NOT throw today -> RED.
  // Fixing it means enforcing an equivalent glob/pattern-length bound at load, or
  // consciously accepting the divergence (the glob is already linear, so a huge
  // pattern is not a ReDoS the way an expanded regex program would be).
  it("RejectsOversizedPattern: an oversized :matches pattern (300 '*') is rejected at load", () => {
    const script = `if header :matches "Subject" "${"*".repeat(300)}" { keep; }`;
    expect(() => compile(script)).toThrow();
  });

  // Cancelled-match abort
  //   With pattern "^(.*)$" and the default limits, a match against an input just
  //   above the guarded-path threshold, when its execution is cancelled mid-flight,
  //   aborts with an error rather than running to completion.
  //
  // TODO(regex): aborting a mid-flight match via external cancellation has NO
  // equivalent in this single-threaded engine — the design drops the background
  // worker + timer; linearity + input truncation are the safety guarantee instead.
  // No public surface for match cancellation.
  it.skip("RespectsCancelledContext: a cancelled context aborts the match promptly", () => {
    // engine/concurrency-only; see TODO above.
  });

  // Guarded-path match on large input
  //   With pattern "needle" and the default limits, a match against
  //   ("x" repeated past twice the guarded-path threshold) + "needle" -> MATCH,
  //   confirming the large-input guarded path stays correct.
  //
  // The "guarded path" (large inputs run under a separate execution budget with a
  // timer) is an internal concurrency detail with no analogue here. The observable
  // behaviour is simply: a `:regex` match still succeeds on a large input. Reachable
  // via a `:regex` header test over a large Subject. Goes RED now (`require "regex"`
  // rejected). The internal threshold is 1024; 2048 mirrors twice that.
  it("GuardedPathMatches: :regex still matches a needle in a large input", () => {
    const bigSubject = `${"x".repeat(2048)}needle`; // "x" repeated to twice the guarded-path threshold, then "needle"
    const bigEml = `Subject: ${bigSubject}\n\nbody\n`;
    // keep does NOT cancel implicit keep.
    expect(run(`require "regex"; if header :regex "Subject" "needle" { keep; }`, bigEml)).toEqual(
      R({ keep: true, implicitKeep: true }),
    );
  });

  // Capture groups preserved under bounding
  //   *-* on foo-bar -> captures ["foo-bar", "foo", "bar"] (len 3) on BOTH engines.
  //   The unicode engine and the octet engine each handle their match path;
  //   bounding `:matches` must not change wildcard capture semantics
  //   (leftmost-lazy `(.*?)`): ${1}="foo", ${2}="bar" (NOT "foo-ba"/"r").
  //
  // Reachable via `string :matches "foo-bar" "*-*"` reading the captures ${1}/${2}.
  // Default comparator i;ascii-casemap => octet engine; :comparator "i;unicode-casemap"
  // => unicode engine. For pure-ASCII "foo-bar" both engines produce identical
  // captures, covering both match paths. Goes RED now (`variables` unsupported).
  describe("CaptureGroupsPreserved: :matches wildcard captures survive bounding", () => {
    it("unicode: *-* on foo-bar -> ${1}=foo ${2}=bar (i;unicode-casemap engine)", () => {
      // This library enforces RFC 5228 §2.7.3 (non-default comparators must be
      // declared with require), so the script additionally requires
      // "comparator-i;unicode-casemap".
      const script =
        `require ["variables", "fileinto", "comparator-i;unicode-casemap"];` +
        ` if string :comparator "i;unicode-casemap" :matches "foo-bar" "*-*" { fileinto "\${1}"; fileinto "\${2}"; }`;
      expect(run(script)).toEqual(R({ fileinto: ["foo", "bar"] }));
    });

    it("octet: *-* on foo-bar -> ${1}=foo ${2}=bar (default i;ascii-casemap/octet engine)", () => {
      const script =
        `require ["variables", "fileinto"];` +
        ` if string :matches "foo-bar" "*-*" { fileinto "\${1}"; fileinto "\${2}"; }`;
      expect(run(script)).toEqual(R({ fileinto: ["foo", "bar"] }));
    });
  });
});

// ---------------------------------------------------------------------------
// Regex limits configuration: exec-time, input-length, effective defaults
// ---------------------------------------------------------------------------
describe("regex config", () => {
  // Per-execution exec-time override
  //   With pattern "(?s).*NEEDLE.*", the default limits, and an input of 200KB of
  //   'x' (above the sync threshold, below MaxInputLength):
  //     a per-execution MaxExecTime of 1ns -> match errors (soft timeout)
  //     a per-execution MaxExecTime of 5s  -> match succeeds
  //
  // TODO(regex): the per-match soft execution wait (MaxExecTime, taken per
  // execution) is inherently timing/concurrency-dependent. By design this engine
  // drops the background worker + timer entirely and relies on a linear engine +
  // input truncation, so there is no preemptible exec-time budget to configure or
  // observe. No public per-execution limits override.
  it.skip("ContextOverridesExecTime: MaxExecTime is read from the context per execution", () => {
    // engine/timing-only; see TODO above.
  });

  // Per-execution input-length override
  //   With pattern "NEEDLE" and an input of 4096 'x' followed by "NEEDLE", a
  //   per-execution MaxInputLength of 1024 truncates the input so NEEDLE (at
  //   offset 4096) is cut away -> NO match.
  //
  // TODO(regex): needs a safe-compile step plus a per-execution MaxInputLength of
  // 1024. Targets the `:regex` engine (not implemented). NOTE: this library exposes
  // a `maxMatchInputLength` load Option that truncates the `:matches` glob input the
  // same way, but that is a load-time option on the glob path, not a per-execution
  // override on the `:regex` engine this case exercises.
  it.skip("ContextOverridesInputLength: MaxInputLength truncation is read from the context", () => {
    // engine-only; see TODO above.
  });

  // Effective-limits defaulting
  //   Given a partial override {MaxExecTime: 2s}, the effective limits are:
  //     MaxExecTime == 2s (override preserved)
  //     MaxInputLength == default (256KB, filled in)
  //     MaxPatternLength == default (1000, filled in)
  //
  // TODO(regex): the effective-limits computation, the default limits, and the
  // limits structure are internal and are not exported by the public API — there
  // is nothing to call. Pure config unit test, no script surface.
  it.skip("EffectiveRegexLimits: a partial RegexLimits override inherits the defaults per-field", () => {
    // engine/config-only; see TODO above.
  });
});
