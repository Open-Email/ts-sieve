// RFC 5260 `date` / `currentdate`.
//
// The corpus covers the happy path (a well-formed RFC 5322 header, a couple of
// parts). This file pins the arms it does not reach: every date-part
// projection, the zone rules (`:zone`/`:originalzone`/default), the parser's
// fallback shapes and its refusals, and the `:index`/`:last` selection edges —
// all of which decide whether a user's date rule fires on real mail.
//
// Everything is asserted through a script, not by calling internals: these are
// contracts a script author can observe, and the interpreter is the only
// supported entry point.

import { describe, expect, it } from "vitest";
import { R, run } from "./harness.js";

const REQ = 'require ["date","fileinto","relational","variables","index","comparator-i;ascii-numeric"];';

/** Build a message with the given Date: header (and optional extra headers). */
function eml(date: string, extra: string[] = []): string {
  return ["From: a@x", "To: b@y", "Subject: hi", ...extra, `Date: ${date}`, "", "body"].join("\r\n");
}

/** Did the single `if` fire? */
function fired(script: string, message: string): boolean {
  return run(`${REQ} ${script}`, message).fileinto.includes("X");
}

/** The value `date` extracts for a part, read back through a variable. */
function part(datePart: string, date: string, tags = ""): string {
  // `:matches "*"` captures the whole extracted value into ${1}.
  const r = run(
    `${REQ} if date ${tags} :matches "date" "${datePart}" "*" { set "got" "\${1}"; fileinto "\${got}"; }`,
    eml(date),
  );
  return r.fileinto[0] ?? "";
}

// A fixed instant with a non-zero offset, so zone handling is observable:
// 2026-08-20T21:30:35+02:00 == 19:30:35Z.
const DATE_P2 = "Thu, 20 Aug 2026 21:30:35 +0200";

describe("date parts (RFC 5260 §4)", () => {
  it("projects every part from one instant, in the header's own zone", () => {
    // :originalzone keeps +0200, so these are the LOCAL fields of that stamp.
    const p = (name: string) => part(name, DATE_P2, ":originalzone");
    expect(p("year")).toBe("2026");
    expect(p("month")).toBe("08");
    expect(p("day")).toBe("20");
    expect(p("date")).toBe("2026-08-20");
    expect(p("hour")).toBe("21");
    expect(p("minute")).toBe("30");
    expect(p("second")).toBe("35");
    expect(p("time")).toBe("21:30:35");
    expect(p("zone")).toBe("+0200");
    expect(p("iso8601")).toBe("2026-08-20T21:30:35+02:00");
    expect(p("std11")).toBe("Thu, 20 Aug 2026 21:30:35 +0200");
    expect(p("weekday")).toBe("4"); // Thursday, 0=Sunday
  });

  it("julian is the Modified Julian Day", () => {
    // MJD 0 is 1858-11-17; 1970-01-01 is 40587 — the anchor worth pinning,
    // since the formula is hand-rolled.
    expect(part("julian", "Thu, 01 Jan 1970 00:00:00 +0000")).toBe("40587");
    expect(part("julian", "Thu, 20 Aug 2026 12:00:00 +0000")).toBe("61272");
  });

  it("negative zones format with the sign and no colon (zone) / with one (iso8601)", () => {
    const d = "Thu, 20 Aug 2026 08:30:35 -0530";
    expect(part("zone", d, ":originalzone")).toBe("-0530");
    expect(part("iso8601", d, ":originalzone")).toBe("2026-08-20T08:30:35-05:30");
    expect(part("std11", d, ":originalzone")).toBe("Thu, 20 Aug 2026 08:30:35 -0530");
  });
});

describe("zone selection", () => {
  it("defaults to UTC — the same instant, normalized", () => {
    // No :zone/:originalzone ⇒ offset 0 (Workers have no local zone).
    expect(part("hour", DATE_P2)).toBe("19");
    expect(part("zone", DATE_P2)).toBe("+0000");
  });

  it(":originalzone keeps the header's own offset", () => {
    expect(part("hour", DATE_P2, ":originalzone")).toBe("21");
  });

  it(":zone shifts the instant into the requested offset", () => {
    expect(part("hour", DATE_P2, ':zone "+0530"')).toBe("01"); // 19:30Z + 5:30
    expect(part("day", DATE_P2, ':zone "+0530"')).toBe("21"); // …crossing midnight
    expect(part("hour", DATE_P2, ':zone "-0800"')).toBe("11");
  });

  it("a malformed :zone is refused at LOAD time, not silently treated as UTC", () => {
    // Better than a runtime fallback: the script author learns at upload that
    // the rule can never mean what they wrote. (This is what makes the
    // runtime catch in applyZone/CurrentDateTest.check unreachable — a loaded
    // script's zone always parses.)
    expect(() => run(`${REQ} if date :zone "bogus" :is "date" "hour" "19" { fileinto "X"; }`, eml(DATE_P2))).toThrow(
      /invalid zone format/,
    );
    expect(() => run(`${REQ} if date :zone "+25x0" :is "date" "hour" "19" { fileinto "X"; }`, eml(DATE_P2))).toThrow(
      /invalid number|invalid zone format/,
    );
    // …and the two zone tags are mutually exclusive.
    expect(() =>
      run(`${REQ} if date :zone "+0200" :originalzone :is "date" "hour" "21" { fileinto "X"; }`, eml(DATE_P2)),
    ).toThrow(/cannot specify both/);
    // An unknown date-part is refused the same way.
    expect(() => run(`${REQ} if date :is "date" "epoch" "0" { fileinto "X"; }`, eml(DATE_P2))).toThrow(
      /invalid date-part/,
    );
  });

  it("currentdate reads the same projection machinery", () => {
    // Compare against the harness's own clock rather than a fixed value.
    const nowYear = String(new Date().getUTCFullYear());
    expect(fired(`if currentdate :is "year" "${nowYear}" { fileinto "X"; }`, eml(DATE_P2))).toBe(true);
    expect(fired('if currentdate :is "year" "1999" { fileinto "X"; }', eml(DATE_P2))).toBe(false);
  });

  it("currentdate honours :zone, and refuses a bad one at load time", () => {
    const r = run(`${REQ} if currentdate :zone "+0300" :matches "zone" "*" { fileinto "\${1}"; }`, eml(DATE_P2));
    expect(r.fileinto[0]).toBe("+0300");
    expect(() =>
      run(`${REQ} if currentdate :zone "nope" :matches "zone" "*" { fileinto "\${1}"; }`, eml(DATE_P2)),
    ).toThrow(/invalid zone format/);
  });
});

describe("header parsing shapes", () => {
  it("parses ISO 8601 / RFC 3339, with and without an explicit offset", () => {
    expect(part("date", "2026-08-20T21:30:35+02:00", ":originalzone")).toBe("2026-08-20");
    expect(part("hour", "2026-08-20T21:30:35+02:00", ":originalzone")).toBe("21");
    expect(part("hour", "2026-08-20T21:30:35Z")).toBe("21"); // Z ⇒ offset 0
    expect(part("hour", "2026-08-20 21:30:35")).toBe("21"); // space separator, no zone
    expect(part("second", "2026-08-20T21:30:35.123Z")).toBe("35"); // fractional seconds dropped
  });

  it("parses RFC 5322 with and without the weekday and seconds", () => {
    expect(part("time", "20 Aug 2026 21:30:35 +0000")).toBe("21:30:35");
    expect(part("time", "Thu, 20 Aug 2026 21:30 +0000")).toBe("21:30:00");
  });

  it("applies the two-digit year rule (00–68 ⇒ 20xx, 69–99 ⇒ 19xx)", () => {
    expect(part("year", "20 Aug 26 12:00:00 +0000")).toBe("2026");
    expect(part("year", "20 Aug 68 12:00:00 +0000")).toBe("2068");
    expect(part("year", "20 Aug 69 12:00:00 +0000")).toBe("1969");
    expect(part("year", "20 Aug 99 12:00:00 +0000")).toBe("1999");
  });

  it("treats a named zone as UTC (no zone database on Workers)", () => {
    expect(part("zone", "Thu, 20 Aug 2026 21:30:35 MST", ":originalzone")).toBe("+0000");
    expect(part("hour", "Thu, 20 Aug 2026 21:30:35 GMT", ":originalzone")).toBe("21");
  });

  it("strips a trailing CFWS comment", () => {
    expect(part("hour", "Thu, 20 Aug 2026 21:30:35 +0000 (UTC)")).toBe("21");
  });

  it("falls back to the text after the last semicolon — the Received: shape", () => {
    // RFC 5260 §4: `date` on a Received header reads its date-time clause.
    const message = [
      "From: a@x",
      "To: b@y",
      "Received: from relay.example by mx.example; Thu, 20 Aug 2026 21:30:35 +0000",
      "",
      "body",
    ].join("\r\n");
    const r = run(`${REQ} if date :matches "received" "hour" "*" { fileinto "\${1}"; }`, message);
    expect(r.fileinto[0]).toBe("21");
  });

  it("an unparseable or absent header is no-match, never an error", () => {
    expect(fired('if date :is "date" "year" "2026" { fileinto "X"; }', eml("not a date at all"))).toBe(false);
    expect(fired('if date :is "date" "year" "2026" { fileinto "X"; }', eml("32 Foo 2026 99:99 +0000"))).toBe(false);
    // No Date: header at all.
    const bare = ["From: a@x", "To: b@y", "", "body"].join("\r\n");
    expect(fired('if date :is "date" "year" "2026" { fileinto "X"; }', bare)).toBe(false);
    // A lone CR is refused rather than parsed through.
    expect(fired('if date :is "date" "year" "2026" { fileinto "X"; }', eml("Thu, 20 Aug 2026\r21:30:35 +0000"))).toBe(
      false,
    );
  });
});

describe(":index / :last selection (RFC 5260 §6)", () => {
  const THREE = [
    "From: a@x",
    "To: b@y",
    "Received: by one; Mon, 17 Aug 2026 01:00:00 +0000",
    "Received: by two; Tue, 18 Aug 2026 02:00:00 +0000",
    "Received: by three; Wed, 19 Aug 2026 03:00:00 +0000",
    "",
    "body",
  ].join("\r\n");

  const day = (tags: string): string =>
    run(`${REQ} if date ${tags} :matches "received" "day" "*" { fileinto "\${1}"; }`, THREE).fileinto[0] ?? "";

  it("requires require \"index\" before :index may be used", () => {
    // RFC 5260 §6 is its own extension; using the tag without it is a load
    // error, not a silently ignored tag.
    expect(() =>
      run(
        'require ["date","fileinto"]; if date :index 2 :is "received" "day" "18" { fileinto "X"; }',
        THREE,
      ),
    ).toThrow(/missing require 'index'/);
    // …and :last is meaningless without :index.
    expect(() =>
      run(
        'require ["date","fileinto","index"]; if date :last :is "received" "day" "19" { fileinto "X"; }',
        THREE,
      ),
    ).toThrow(/:last requires :index/);
  });

  it("selects the nth field from the top, and the nth from the bottom with :last", () => {
    expect(day("")).toBe("17"); // no :index ⇒ first
    expect(day(":index 1")).toBe("17");
    expect(day(":index 2")).toBe("18");
    expect(day(":index 3")).toBe("19");
    expect(day(":index 1 :last")).toBe("19");
    expect(day(":index 2 :last")).toBe("18");
    expect(day(":index 3 :last")).toBe("17");
  });

  it("an out-of-range :index is no-match in both directions", () => {
    expect(day(":index 4")).toBe("");
    expect(day(":index 4 :last")).toBe("");
  });
});

describe(":count and relational forms", () => {
  const TWO_PARSEABLE = [
    "From: a@x",
    "To: b@y",
    "Received: by one; Mon, 17 Aug 2026 01:00:00 +0000",
    "Received: by two; Tue, 18 Aug 2026 02:00:00 +0000",
    "Received: this one has no date clause",
    "",
    "body",
  ].join("\r\n");

  it(":count counts only the fields that actually parse", () => {
    const hit = (n: string) =>
      run(
        `${REQ} if date :count "eq" :comparator "i;ascii-numeric" "received" "day" "${n}" { fileinto "X"; }`,
        TWO_PARSEABLE,
      ).fileinto.includes("X");
    expect(hit("2")).toBe(true);
    expect(hit("3")).toBe(false);
  });

  it(":value orders date parts numerically", () => {
    const after = fired(
      'if date :value "gt" :comparator "i;ascii-numeric" "date" "year" "2000" { fileinto "X"; }',
      eml(DATE_P2),
    );
    expect(after).toBe(true);
    const before = fired(
      'if date :value "lt" :comparator "i;ascii-numeric" "date" "year" "2000" { fileinto "X"; }',
      eml(DATE_P2),
    );
    expect(before).toBe(false);
  });
});

describe("interaction with editheader", () => {
  it("date sees an addheader edit, per RFC 5293", () => {
    // The ledger is replayed on read, so a script-added Date is testable.
    const bare = ["From: a@x", "To: b@y", "", "body"].join("\r\n");
    const r = run(
      'require ["date","fileinto","editheader"]; addheader "X-Stamp" "Thu, 20 Aug 2026 21:30:35 +0000"; if date :is "x-stamp" "year" "2026" { fileinto "X"; }',
      bare,
    );
    expect(r).toEqual(R({ fileinto: ["X"] }));
  });
});
