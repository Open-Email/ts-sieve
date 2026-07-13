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
