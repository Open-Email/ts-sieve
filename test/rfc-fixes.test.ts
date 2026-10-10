// Regression tests for RFC-correctness and robustness fixes that go beyond the
// core conformance corpus. Each describe block names the defect it pins down.

import { describe, expect, it } from "vitest";
import { load } from "../src/index.js";
import { compile, eml, R, run } from "./harness.js";

const twoTo = `From: a@x.com
To: b@y.com, c@z.com
To: d@w.com
Subject: hi

body
`;

describe("RFC 5231 :count on header/address/envelope", () => {
  it("header :count counts field instances across the named headers", () => {
    expect(
      run('require "relational"; if header :count "eq" "to" "2" { keep; }', twoTo, {
        options: { enabledExtensions: ["relational", "comparator-i;ascii-numeric"] },
      }),
    ).toEqual(R({ keep: true, implicitKeep: true }));
  });

  it("header :count over multiple header names sums the instances", () => {
    expect(
      run(
        'require "relational"; if header :count "eq" ["to", "from"] "3" { keep; }',
        twoTo,
      ),
    ).toEqual(R({ keep: true, implicitKeep: true }));
  });

  it("address :count counts parsed addresses, not header fields", () => {
    // To: has 3 addresses across 2 field instances.
    expect(
      run('require "relational"; if address :count "eq" "to" "3" { keep; }', twoTo),
    ).toEqual(R({ keep: true, implicitKeep: true }));
  });

  it("envelope :count counts non-empty envelope parts", () => {
    expect(
      run(
        'require ["envelope", "relational"]; if envelope :count "eq" ["from", "to"] "2" { keep; }',
        twoTo,
      ),
    ).toEqual(R({ keep: true, implicitKeep: true }));
  });

  it("a :count that does not hold matches nothing", () => {
    expect(
      run('require "relational"; if header :count "gt" "to" "5" { keep; }', twoTo),
    ).toEqual(R({ implicitKeep: true }));
  });
});

describe("RFC 5229 variable expansion in name arguments", () => {
  it("header test expands ${} in the header name", () => {
    expect(
      run('require "variables"; set "h" "subject"; if header :contains "${h}" "present" { keep; }', eml),
    ).toEqual(R({ keep: true, implicitKeep: true }));
  });

  it("exists expands ${} in the field name", () => {
    expect(run('require "variables"; set "h" "subject"; if exists "${h}" { keep; }', eml)).toEqual(
      R({ keep: true, implicitKeep: true }),
    );
  });

  it("address test expands ${} in the header name", () => {
    expect(
      run('require "variables"; set "h" "from"; if address :domain :is "${h}" "desert.example.org" { keep; }', eml),
    ).toEqual(R({ keep: true, implicitKeep: true }));
  });

  it(":is match keys are expanded", () => {
    expect(
      run('require "variables"; set "who" "coyote@desert.example.org"; if header :is "from" "${who}" { keep; }', eml),
    ).toEqual(R({ keep: true, implicitKeep: true }));
  });

  it(":contains match keys are expanded", () => {
    expect(
      run('require "variables"; set "word" "present"; if header :contains "subject" "${word}" { keep; }', eml),
    ).toEqual(R({ keep: true, implicitKeep: true }));
  });
});

describe("RFC 5228 §2.7.3 comparator require-gating", () => {
  it("i;ascii-numeric without its require is rejected at load", () => {
    expect(() =>
      compile('require "relational"; if header :value "eq" :comparator "i;ascii-numeric" "x" "1" { keep; }', {
        enabledExtensions: ["relational", "comparator-i;ascii-numeric"],
      }),
    ).toThrow(/comparator-i;ascii-numeric/);
  });

  it("i;unicode-casemap without its require is rejected at load", () => {
    expect(() => compile('if header :is :comparator "i;unicode-casemap" "x" "y" { keep; }')).toThrow(
      /comparator-i;unicode-casemap/,
    );
  });

  it("i;octet and i;ascii-casemap need no require", () => {
    expect(() =>
      compile('if header :is :comparator "i;octet" "x" "y" { keep; }', { enabledExtensions: [] }),
    ).not.toThrow();
  });
});

describe("RFC 4790 §9.1.1 i;ascii-numeric digit-prefix semantics", () => {
  const emlNum = `X-Score: 42 points\nSubject: s\n\nb\n`;

  it(":value compares the leading digit prefix ('42 points' = 42)", () => {
    expect(
      run(
        'require ["relational", "comparator-i;ascii-numeric"]; if header :value "eq" :comparator "i;ascii-numeric" "x-score" "42" { keep; }',
        emlNum,
      ),
    ).toEqual(R({ keep: true, implicitKeep: true }));
  });

  it(":is agrees with :value on prefix semantics", () => {
    expect(
      run(
        'require "comparator-i;ascii-numeric"; if header :is :comparator "i;ascii-numeric" "x-score" "42" { keep; }',
        emlNum,
      ),
    ).toEqual(R({ keep: true, implicitKeep: true }));
  });

  it("non-numeric strings are +infinity (gt any number)", () => {
    expect(
      run(
        'require ["relational", "comparator-i;ascii-numeric"]; if header :value "gt" :comparator "i;ascii-numeric" "subject" "999999" { keep; }',
        emlNum,
      ),
    ).toEqual(R({ keep: true, implicitKeep: true }));
  });
});

describe("RFC 5232 hasflag", () => {
  it("matches a flag set by setflag", () => {
    expect(
      run('require "imap4flags"; setflag "\\\\Seen"; if hasflag "\\\\Seen" { keep; }'),
    ).toEqual(R({ keep: true, implicitKeep: true, flags: ["\\seen"] }));
  });

  it("does not match after removeflag", () => {
    expect(
      run('require "imap4flags"; setflag "\\\\Seen"; removeflag "\\\\Seen"; if hasflag "\\\\Seen" { keep; }'),
    ).toEqual(R({ implicitKeep: true }));
  });

  it("hasflag :count counts the flags in the set", () => {
    expect(
      run(
        'require ["imap4flags", "relational", "comparator-i;ascii-numeric"]; addflag ["a", "b c"]; if hasflag :count "eq" :comparator "i;ascii-numeric" "3" { keep; }',
      ),
    ).toEqual(R({ keep: true, implicitKeep: true, flags: ["a", "b", "c"] }));
  });

  it("hasflag over a variable list (RFC 5232 §5 two-argument form)", () => {
    expect(
      run(
        'require ["imap4flags", "variables"]; set "myflags" "junk \\\\seen"; if hasflag "myflags" "junk" { keep; }',
      ),
    ).toEqual(R({ keep: true, implicitKeep: true }));
  });

  it("the two-argument form without variables is rejected at load", () => {
    expect(() =>
      compile('require "imap4flags"; if hasflag "myflags" "junk" { keep; }', {
        enabledExtensions: ["imap4flags"],
      }),
    ).toThrow(/variables/);
  });

  it("hasflag without require imap4flags is rejected at load", () => {
    expect(() => compile('if hasflag "x" { keep; }', { enabledExtensions: [] })).toThrow(/imap4flags/);
  });

  it("hasflag splits a multi-flag key and matches by membership (RFC 5232 §5)", () => {
    // set = {\\flagged, \\seen}; the two-flag key is split and matches if EITHER is present.
    expect(
      run('require "imap4flags"; setflag "\\\\Seen \\\\Flagged"; if hasflag :is "\\\\flagged \\\\seen" { keep; }'),
    ).toEqual(R({ keep: true, implicitKeep: true, flags: ["\\flagged", "\\seen"] }));
    expect(run('require "imap4flags"; setflag "\\\\Seen"; if hasflag "\\\\Deleted" { keep; }')).toEqual(
      R({ implicitKeep: true, flags: ["\\seen"] }),
    );
  });
});

describe("RFC 5232 §5 imap4flags variable form (setflag/addflag/removeflag <var>)", () => {
  it("setflag stores an order-preserving, deduped flag string in the variable", () => {
    expect(
      run(
        'require ["imap4flags", "variables"]; setflag "flags" "\\\\seen $frop \\\\seen"; if string "${flags}" "\\\\seen $frop" { keep; }',
      ),
    ).toEqual(R({ keep: true, implicitKeep: true }));
  });

  it("addflag/removeflag mutate the named variable, not the internal flag set", () => {
    // frop = a → a b c → a c; the internal flag set stays empty (implicitKeep only).
    expect(
      run(
        'require ["imap4flags", "variables"]; setflag "frop" "a"; addflag "frop" ["b", "c"]; removeflag "frop" "b"; if string "${frop}" "a c" { keep; }',
      ),
    ).toEqual(R({ keep: true, implicitKeep: true }));
  });

  it("the variable form without require variables is rejected at load", () => {
    expect(() =>
      compile('require "imap4flags"; setflag "frop" "a";', { enabledExtensions: ["imap4flags"] }),
    ).toThrow(/variables/);
  });
});

describe("RFC 5260 §4 date on Received headers", () => {
  const rcvd =
    "Received: from mx.a.example (10.0.0.1) by mx.b.example (10.0.0.2)\r\n with ESMTP id 1.2.3.4; Wed, 12 Nov 2014 18:18:31 +0100\r\n\r\nbody\r\n";

  it("extracts the date-time after the final semicolon", () => {
    expect(run('require "date"; if date "received" "second" "31" { keep; }', rcvd)).toEqual(
      R({ keep: true, implicitKeep: true }),
    );
  });

  it("still parses a whole-field date (Date:)", () => {
    const eml = "Date: Wed, 12 Nov 2014 18:18:29 +0100\r\n\r\nbody\r\n";
    expect(run('require "date"; if date "date" "second" "29" { keep; }', eml)).toEqual(
      R({ keep: true, implicitKeep: true }),
    );
  });
});

describe("RFC 5260 :index/:last on header and address", () => {
  const emlIdx = `Received: one
Received: two
Received: three
To: first@x.com
To: second@y.com
Subject: s

b
`;

  it("header :index selects the nth field instance", () => {
    expect(run('require "index"; if header :index 2 :is "received" "two" { keep; }', emlIdx)).toEqual(
      R({ keep: true, implicitKeep: true }),
    );
    expect(run('require "index"; if header :index 2 :is "received" "one" { keep; }', emlIdx)).toEqual(
      R({ implicitKeep: true }),
    );
  });

  it("header :index :last counts from the end", () => {
    expect(run('require "index"; if header :index 1 :last :is "received" "three" { keep; }', emlIdx)).toEqual(
      R({ keep: true, implicitKeep: true }),
    );
  });

  it("an out-of-range :index matches nothing", () => {
    expect(run('require "index"; if header :index 9 :is "received" "one" { keep; }', emlIdx)).toEqual(
      R({ implicitKeep: true }),
    );
  });

  it("address :index selects the nth field instance", () => {
    expect(
      run('require "index"; if address :index 2 :localpart :is "to" "second" { keep; }', emlIdx),
    ).toEqual(R({ keep: true, implicitKeep: true }));
    expect(
      run('require "index"; if address :index 1 :localpart :is "to" "second" { keep; }', emlIdx),
    ).toEqual(R({ implicitKeep: true }));
  });

  it(":index without require 'index' is rejected at load", () => {
    expect(() =>
      compile('if header :index 1 :is "received" "one" { keep; }', { enabledExtensions: [] }),
    ).toThrow(/index/);
  });

  it(":last without :index is rejected at load", () => {
    expect(() => compile('require "index"; if header :last :is "received" "one" { keep; }')).toThrow(/:index/);
  });
});

describe("regex engine robustness", () => {
  it("rejects huge {n} repetition counts instead of expanding them", () => {
    expect(() =>
      compile('require "regex"; if header :regex "subject" "a{999999999}" { keep; }'),
    ).toThrow(/repetition/);
  });

  it("rejects nested repeats that would blow up the compiled program", () => {
    expect(() =>
      compile('require "regex"; if header :regex "subject" "(((a{1000}){1000}){1000})" { keep; }'),
    ).toThrow();
  });

  it("rejects an inverted range {2,1}", () => {
    expect(() => compile('require "regex"; if header :regex "subject" "a{2,1}" { keep; }')).toThrow();
  });

  it("matches astral-plane literals in :regex", () => {
    expect(run('require "regex"; if header :regex "subject" "😀+" { keep; }', "Subject: hi 😀😀\n\nb\n")).toEqual(
      R({ keep: true, implicitKeep: true }),
    );
  });

  it("matches astral-plane literals in :matches", () => {
    expect(run('if header :matches "subject" "*😀*" { keep; }', "Subject: hi 😀 there\n\nb\n", {
      enabledExtensions: [],
    })).toEqual(R({ keep: true, implicitKeep: true }));
  });

  it("a trailing backslash in :matches stays an exact (anchored) match", () => {
    // Pattern "abc\" must NOT behave as prefix-match "abc".
    expect(run('if header :matches "subject" "abc\\\\" { keep; }', "Subject: abcdef\n\nb\n", {
      enabledExtensions: [],
    })).toEqual(R({ implicitKeep: true }));
  });
});

describe("lexer/loader robustness", () => {
  it("rejects numbers that overflow safe integers", () => {
    expect(() => load(`if size :over 99999999999999999999 { keep; }`, { enabledExtensions: [] })).toThrow(
      /number/i,
    );
    expect(() => load(`if size :over 9999999999999999G { keep; }`, { enabledExtensions: [] })).toThrow(/number/i);
  });

  it("addheader refuses CR/LF header-value injection", () => {
    expect(() =>
      run(
        'require ["editheader", "variables"]; set "v" "x"; addheader "X-A" "a\r\nX-Evil: b"; keep;',
      ),
    ).toThrow(/invalid header value/);
  });
});

describe("editheader visibility in date test", () => {
  it("date sees a header added by addheader", () => {
    expect(
      run(
        'require ["editheader", "date"]; addheader "X-When" "Tue, 1 Apr 1997 09:06:31 -0800"; if date :originalzone "x-when" "year" "1997" { keep; }',
        eml,
      ),
    ).toEqual(R({ keep: true, implicitKeep: true }));
  });
});

// RFC 5322 §3.4: name-addr = [display-name] angle-addr, so "<user@example.com>"
// is a valid mailbox whose address is user@example.com. Bulk mailers send To:
// and From: in this form; comparing it literally (brackets and all) made every
// :is/:matches/:localpart/:domain rule on it miss silently. A non-ASCII local
// part (RFC 6532) parses the same way as it does with a display name.
describe("RFC 5322 bare angle-addr in the address test", () => {
  const msg = (field: string, value: string) => `${field}: ${value}\nSubject: hi\n\nbody\n`;
  const kept = R({ keep: true, implicitKeep: true });
  const notKept = R({ implicitKeep: true });

  it(":is :all matches the address inside the brackets", () => {
    expect(run('if address :is "to" "user@example.com" { keep; }', msg("To", "<user@example.com>"))).toEqual(kept);
  });

  it(":domain and :localpart see the parsed address", () => {
    expect(run('if address :domain :is "to" "example.com" { keep; }', msg("To", "<user@example.com>"))).toEqual(kept);
    expect(run('if address :localpart :is "to" "user" { keep; }', msg("To", "<user@example.com>"))).toEqual(kept);
  });

  it(":matches is not defeated by a trailing bracket", () => {
    expect(run('if address :matches "from" "*@example.com" { keep; }', msg("From", "<a@example.com>"))).toEqual(kept);
  });

  it("surrounding whitespace and comments do not change the address", () => {
    expect(
      run('if address :is "from" "a@example.com" { keep; }', msg("From", "  <a@example.com> (bulk)")),
    ).toEqual(kept);
  });

  it("the brackets are not part of the matched address", () => {
    expect(run('if address :is "to" "<user@example.com>" { keep; }', msg("To", "<user@example.com>"))).toEqual(
      notKept,
    );
  });

  it(":count counts a bare angle-addr as one address", () => {
    expect(
      run('require "relational"; if address :count "eq" "to" "1" { keep; }', msg("To", "<a@example.com>")),
    ).toEqual(kept);
  });

  it("a non-ASCII local part parses as it does with a display name", () => {
    expect(run('if address :is "to" "josé@example.com" { keep; }', msg("To", "<josé@example.com>"))).toEqual(kept);
    expect(run('if address :localpart :is "to" "josé" { keep; }', msg("To", "<josé@example.com>"))).toEqual(kept);
    expect(run('if address :is "to" "josé@example.com" { keep; }', msg("To", "José <josé@example.com>"))).toEqual(
      kept,
    );
  });

  it("a word that is not an address still matches :all as itself", () => {
    expect(run('if address :is :all "cc" "nonsense" { keep; }', msg("Cc", "nonsense"))).toEqual(kept);
  });

  it("an empty angle-addr is the null address", () => {
    expect(run('if address :is :all "cc" "" { keep; }', msg("Cc", "<>"))).toEqual(kept);
  });
});

// RFC 5322 §3.4 group = display-name ":" [group-list] ";". RFC 5228 §5.1: the
// address test "never acts on group names ... although it does act on the
// addresses within the group construct". The group name used to be glued onto
// the first member's local part ("tukkers: henk").
describe("RFC 5322 group syntax in the address test", () => {
  const group = "Cc: tukkers: henk@tukkerland.ex, theo@tukkerland.ex;\nTo: undisclosed-recipients:;\nSubject: hi\n\nbody\n";
  const msg = (field: string, value: string) => `${field}: ${value}\nSubject: hi\n\nbody\n`;
  const kept = R({ keep: true, implicitKeep: true });
  const notKept = R({ implicitKeep: true });

  it("matches every member of a group, the first one included", () => {
    expect(run('if address :localpart :is "cc" "henk" { keep; }', group)).toEqual(kept);
    expect(run('if address :localpart :is "cc" "theo" { keep; }', group)).toEqual(kept);
    expect(run('if address :is "cc" "henk@tukkerland.ex" { keep; }', group)).toEqual(kept);
  });

  it("never matches the group name", () => {
    expect(run('if address :contains "cc" "tukkers" { keep; }', group)).toEqual(notKept);
  });

  it("counts the members, and an empty group as none", () => {
    expect(run('require "relational"; if address :count "eq" "cc" "2" { keep; }', group)).toEqual(kept);
    expect(run('require "relational"; if address :count "eq" "to" "0" { keep; }', group)).toEqual(kept);
  });

  it("addresses after a group in the same field still match", () => {
    const msg = "To: team: a@x.example;, b@y.example\nSubject: hi\n\nbody\n";
    expect(run('if address :is "to" "a@x.example" { keep; }', msg)).toEqual(kept);
    expect(run('if address :is "to" "b@y.example" { keep; }', msg)).toEqual(kept);
    expect(run('require "relational"; if address :count "eq" "to" "2" { keep; }', msg)).toEqual(kept);
  });

  it("a colon inside quotes or an angle-addr source route is not a group", () => {
    expect(
      run('if address :is "from" "a@x.example" { keep; }', 'From: "Re: news" <a@x.example>\nSubject: hi\n\nbody\n'),
    ).toEqual(kept);
    const routed = "To: Foo <@a.example:u@x.example>, b@y.example\nSubject: hi\n\nbody\n";
    expect(run('if address :is "to" "b@y.example" { keep; }', routed)).toEqual(kept);
    expect(run('require "relational"; if address :count "eq" "to" "2" { keep; }', routed)).toEqual(kept);
  });

  // A display-name phrase can hold no unquoted "@", "<" or ">", so a colon
  // after any of them is not a group: it is part of an address (an IPv6
  // domain-literal) or trailing junk, and the address before it must survive.
  it("a colon after an address does not open a group", () => {
    const ipv6 = msg("To", "user@[IPv6:2001:db8::1]");
    expect(run('if address :is "to" "user@[IPv6:2001:db8::1]" { keep; }', ipv6)).toEqual(kept);
    expect(run('if address :localpart :is "to" "user" { keep; }', ipv6)).toEqual(kept);
    expect(run('if address :domain :is "to" "[IPv6:2001:db8::1]" { keep; }', ipv6)).toEqual(kept);
    expect(run('if address :is "to" "a@x.example" { keep; }', msg("To", "<a@x.example>:"))).toEqual(kept);
    expect(run('if address :is "to" "" { keep; }', msg("To", "<a@x.example>:"))).toEqual(notKept);
    expect(
      run('if address :contains "to" "a@x.example" { keep; }', msg("To", "a@x.example (Team (eng) note: urgent)")),
    ).toEqual(kept);
  });

  it("a semicolon outside a group does not split mailboxes", () => {
    expect(
      run('require "relational"; if address :count "eq" "to" "1" { keep; }', msg("To", "Smith; John <j@x.example>")),
    ).toEqual(kept);
    expect(run('if address :is "to" "Smith" { keep; }', msg("To", "Smith; John <j@x.example>"))).toEqual(notKept);
  });
});
