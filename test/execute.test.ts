// Execution conformance tests — fileinto, redirect, address, envelope, copy,
// imap4flags, subaddress, variables, regex, relational, date, index, editheader,
// mailbox (+ the base tests address/header/exists/size/allof/anyof/not).
//
// Each self-contained case pins the exact Sieve script, the exact message fixture
// (eml / emlSub / ""), and the exact expected Result. shouldFail cases assert that
// run() throws (load or execute error).
//
// The harness enables the FULL extension set, so not-yet-implemented extensions
// (regex/date/editheader/mailbox/variables) fail RED here until they land — the
// assertions are written as positive assertions.

import { describe, expect, it } from "vitest";
import { eml, emlSub, R, run } from "./harness.js";

// fileinto — fixture eml
describe("fileinto", () => {
  it("single", () => {
    expect(run('require "fileinto"; fileinto "test";', eml)).toEqual(R({ fileinto: ["test"], implicitKeep: false }));
  });
  it("multiple", () => {
    expect(run('require "fileinto"; fileinto "test"; fileinto "test2";', eml)).toEqual(
      R({ fileinto: ["test", "test2"], implicitKeep: false }),
    );
  });
});

// redirect — fixture eml
describe("redirect", () => {
  it("redirect", () => {
    expect(run('redirect "user@example.com";', eml)).toEqual(R({ redirect: ["user@example.com"], implicitKeep: false }));
  });
});

// address — fixture eml
describe("address", () => {
  it("is", () => {
    expect(run('if address :is "From" "coyote@desert.example.org" { keep; }', eml)).toEqual(
      R({ keep: true, implicitKeep: true }),
    );
  });
  it("contains-domain", () => {
    expect(run('if address :contains :domain "To" "acme.example.com" { keep; }', eml)).toEqual(
      R({ keep: true, implicitKeep: true }),
    );
  });
});

// envelope — fixture eml
describe("envelope", () => {
  it("is-from", () => {
    expect(run('require "envelope"; if envelope :is "from" "from@test.com" { keep; }', eml)).toEqual(
      R({ keep: true, implicitKeep: true }),
    );
  });
  it("contains-to", () => {
    expect(
      run(
        'require ["envelope", "copy"]; if envelope :contains "to" "test.com" { redirect :copy "another@example.com"; }',
        eml,
      ),
    ).toEqual(R({ redirect: ["another@example.com"], implicitKeep: true }));
  });
});

// exists — fixture eml
describe("exists", () => {
  it("simple-true", () => {
    expect(run('if exists "From" { keep; }', eml)).toEqual(R({ keep: true, implicitKeep: true }));
  });
  it("simple-false", () => {
    expect(run('if exists "X-Nonexistent-Header" { discard; }', eml)).toEqual(R({ implicitKeep: true }));
  });
  it("multiple-headers-fail", () => {
    expect(run('if exists ["X-Nonexistent-Header", "Subject"] { keep; }', eml)).toEqual(
      R({ keep: false, implicitKeep: true }),
    );
  });
  it("multiple-headers-pass", () => {
    expect(run('if exists ["Subject", "From"] { keep; }', eml)).toEqual(R({ keep: true, implicitKeep: true }));
  });
});

// header — fixture eml
describe("header", () => {
  it("is-true", () => {
    expect(run('if header :is "Subject" "I have a present for you" { keep; }', eml)).toEqual(
      R({ keep: true, implicitKeep: true }),
    );
  });
  it("contains-true", () => {
    expect(run('if header :contains "From" "desert.example" { keep; }', eml)).toEqual(
      R({ keep: true, implicitKeep: true }),
    );
  });
  it("is-false", () => {
    expect(run('if header :is "Subject" "Not the right subject" { keep; }', eml)).toEqual(R({ implicitKeep: true }));
  });
});

// regex — fixture eml
describe("regex", () => {
  it("string-regex-match", () => {
    expect(
      run(
        'require ["variables", "regex"]; set "subject" "I have a present for you"; if string :comparator "i;octet" :regex "${subject}" "I have a (.*) for you" { keep; }',
        eml,
      ),
    ).toEqual(R({ keep: true, implicitKeep: true }));
  });
  it("header-regex-match", () => {
    expect(
      run('require "regex"; if header :comparator "i;octet" :regex "Subject" "I have a (.*) for you" { keep; }', eml),
    ).toEqual(R({ keep: true, implicitKeep: true }));
  });
  it("header-regex-case-insensitive", () => {
    expect(run('require "regex"; if header :regex "Subject" "(?i)I HAVE A (.*) FOR YOU" { keep; }', eml)).toEqual(
      R({ keep: true, implicitKeep: true }),
    );
  });
  it("regex-no-match", () => {
    expect(run('require "regex"; if header :regex "Subject" "No match pattern" { keep; }', eml)).toEqual(
      R({ implicitKeep: true }),
    );
  });
  it("regex-without-require-error", () => {
    expect(() => run('if header :regex "Subject" "test" { keep; }', eml)).toThrow();
  });
});

// allof — fixture eml
describe("allof", () => {
  it("all-true", () => {
    expect(run('if allof (exists "Subject", size :over 100) { keep; }', eml)).toEqual(
      R({ keep: true, implicitKeep: true }),
    );
  });
  it("one-false", () => {
    expect(run('if allof (exists "X-Nonexistent-Header", size :over 100) { keep; }', eml)).toEqual(
      R({ implicitKeep: true }),
    );
  });
});

// anyof — fixture eml
describe("anyof", () => {
  it("one-true", () => {
    expect(run('if anyof (exists "X-Nonexistent-Header", size :over 100) { keep; }', eml)).toEqual(
      R({ keep: true, implicitKeep: true }),
    );
  });
  it("all-false", () => {
    expect(run('if anyof (exists "X-Nonexistent-Header", size :under 100) { keep; }', eml)).toEqual(
      R({ implicitKeep: true }),
    );
  });
});

// not — fixture eml
describe("not", () => {
  it("not-true-is-false", () => {
    expect(run('if not exists "From" { keep; }', eml)).toEqual(R({ implicitKeep: true }));
  });
  it("not-false-is-true", () => {
    expect(run('if not exists "X-Nonexistent" { keep; }', eml)).toEqual(R({ keep: true, implicitKeep: true }));
  });
  it("not-allof-false-is-true", () => {
    expect(run('if not allof (exists "From", exists "X-Nonexistent") { keep; }', eml)).toEqual(
      R({ keep: true, implicitKeep: true }),
    );
  });
});

// size — fixture eml (MessageSize = 606)
describe("size", () => {
  it("over-true", () => {
    expect(run('if size :over 600 { keep; }', eml)).toEqual(R({ keep: true, implicitKeep: true }));
  });
  it("over-false-equal", () => {
    expect(run('if size :over 606 { keep; }', eml)).toEqual(R({ keep: false, implicitKeep: true }));
  });
  it("over-false-greater", () => {
    expect(run('if size :over 607 { keep; }', eml)).toEqual(R({ keep: false, implicitKeep: true }));
  });
  it("under-true", () => {
    expect(run('if size :under 607 { keep; }', eml)).toEqual(R({ keep: true, implicitKeep: true }));
  });
  it("under-false-equal", () => {
    expect(run('if size :under 606 { keep; }', eml)).toEqual(R({ keep: false, implicitKeep: true }));
  });
  it("under-false-less", () => {
    expect(run('if size :under 605 { keep; }', eml)).toEqual(R({ keep: false, implicitKeep: true }));
  });
  it("no-tag-error", () => {
    expect(() => run('if size 100 { keep; }', eml)).toThrow();
  });
  it("both-tags-error", () => {
    expect(() => run('if size :over 100 :under 200 { keep; }', eml)).toThrow();
  });
  it("invalid-number-error", () => {
    expect(() => run('if size :over "abc" { keep; }', eml)).toThrow();
  });
});

// date — fixture eml (Date: Tue, 1 Apr 1997 09:06:31 -0800 (PST))
describe("date", () => {
  it("date-year", () => {
    expect(run('require "date"; if date :is :originalzone "date" "year" "1997" { keep; }', eml)).toEqual(
      R({ keep: true, implicitKeep: true }),
    );
  });
  it("date-month", () => {
    expect(run('require "date"; if date :is :originalzone "date" "month" "04" { keep; }', eml)).toEqual(
      R({ keep: true, implicitKeep: true }),
    );
  });
  it("date-weekday", () => {
    expect(run('require "date"; if date :is :originalzone "date" "weekday" "2" { keep; }', eml)).toEqual(
      R({ keep: true, implicitKeep: true }),
    );
  });
  it("date-hour-originalzone", () => {
    expect(run('require "date"; if date :is :originalzone "date" "hour" "09" { keep; }', eml)).toEqual(
      R({ keep: true, implicitKeep: true }),
    );
  });
  it("date-zone-shift", () => {
    expect(run('require "date"; if date :is :zone "+0000" "date" "hour" "17" { keep; }', eml)).toEqual(
      R({ keep: true, implicitKeep: true }),
    );
  });
  it("date-relational", () => {
    expect(
      run('require ["date", "relational"]; if date :value "ge" :originalzone "date" "year" "1990" { keep; }', eml),
    ).toEqual(R({ keep: true, implicitKeep: true }));
  });
  it("date-no-match", () => {
    expect(run('require "date"; if date :is :originalzone "date" "year" "2020" { keep; }', eml)).toEqual(
      R({ implicitKeep: true }),
    );
  });
  it("currentdate-year", () => {
    expect(run('require "date"; if currentdate :matches "year" "20*" { keep; }', eml)).toEqual(
      R({ keep: true, implicitKeep: true }),
    );
  });
  it("date-without-require-error", () => {
    expect(() => run('if date :is "date" "year" "1997" { keep; }', eml)).toThrow();
  });
  it("currentdate-vacation-style", () => {
    const script =
      'require ["date", "relational"];\n' +
      'if allof (\n' +
      '  currentdate :value "ge" "date" "2020-01-01",\n' +
      '  currentdate :value "le" "date" "2030-12-31"\n' +
      ") {\n" +
      "  keep;\n" +
      "}";
    expect(run(script, eml)).toEqual(R({ keep: true, implicitKeep: true }));
  });
});

// editheader — fixture eml
describe("editheader", () => {
  it("addheader-and-exists", () => {
    expect(run('require "editheader"; addheader "X-Test" "hello"; if exists "X-Test" { keep; }', eml)).toEqual(
      R({ keep: true, implicitKeep: true }),
    );
  });
  it("addheader-and-header-test", () => {
    expect(
      run('require "editheader"; addheader "X-Test" "hello world"; if header :contains "X-Test" "hello" { keep; }', eml),
    ).toEqual(R({ keep: true, implicitKeep: true }));
  });
  it("addheader-without-require", () => {
    expect(() => run('addheader "X-Test" "hello"; keep;', eml)).toThrow();
  });
  it("deleteheader-without-require", () => {
    expect(() => run('deleteheader "Subject"; keep;', eml)).toThrow();
  });
  it("addheader-last", () => {
    expect(run('require "editheader"; addheader :last "X-Test" "world"; if exists "X-Test" { keep; }', eml)).toEqual(
      R({ keep: true, implicitKeep: true }),
    );
  });
  it("deleteheader-protected-received", () => {
    expect(run('require "editheader"; deleteheader "Received"; keep;', eml)).toEqual(
      R({ keep: true, implicitKeep: true }),
    );
  });
  it("deleteheader-protected-auto-submitted", () => {
    expect(run('require "editheader"; deleteheader "Auto-Submitted"; keep;', eml)).toEqual(
      R({ keep: true, implicitKeep: true }),
    );
  });
  it("addheader-then-delete", () => {
    expect(
      run(
        'require "editheader"; addheader "X-Test" "value"; deleteheader "X-Test"; if not exists "X-Test" { keep; }',
        eml,
      ),
    ).toEqual(R({ keep: true, implicitKeep: true }));
  });
  it("delete-existing-subject", () => {
    expect(
      run('require "editheader"; deleteheader "Subject"; if not exists "Subject" { keep; }', eml),
    ).toEqual(R({ keep: true, implicitKeep: true }));
  });
  it("deleteheader-with-is-match", () => {
    expect(
      run(
        'require "editheader"; deleteheader :is "Subject" "I have a present for you"; if not exists "Subject" { keep; }',
        eml,
      ),
    ).toEqual(R({ keep: true, implicitKeep: true }));
  });
  it("deleteheader-with-is-no-match", () => {
    expect(
      run('require "editheader"; deleteheader :is "Subject" "wrong value"; if exists "Subject" { keep; }', eml),
    ).toEqual(R({ keep: true, implicitKeep: true }));
  });
  it("deleteheader-with-contains", () => {
    expect(
      run('require "editheader"; deleteheader :contains "Subject" "present"; if not exists "Subject" { keep; }', eml),
    ).toEqual(R({ keep: true, implicitKeep: true }));
  });
  it("deleteheader-with-matches", () => {
    expect(
      run('require "editheader"; deleteheader :matches "Subject" "I have*"; if not exists "Subject" { keep; }', eml),
    ).toEqual(R({ keep: true, implicitKeep: true }));
  });
  it("addheader-multiple-same-name", () => {
    expect(
      run(
        'require "editheader"; addheader "X-Test" "value1"; addheader "X-Test" "value2"; if header :contains "X-Test" "value1" { keep; }',
        eml,
      ),
    ).toEqual(R({ keep: true, implicitKeep: true }));
  });
  it("addheader-with-variables", () => {
    expect(
      run(
        'require ["editheader", "variables"]; set "tag" "important"; addheader "X-Tag" "${tag}"; if header :is "X-Tag" "important" { keep; }',
        eml,
      ),
    ).toEqual(R({ keep: true, implicitKeep: true }));
  });
  it("deleteheader-index", () => {
    expect(
      run(
        'require "editheader"; addheader "X-Test" "first"; addheader "X-Test" "second"; deleteheader :index 1 "X-Test"; if exists "X-Test" { keep; }',
        eml,
      ),
    ).toEqual(R({ keep: true, implicitKeep: true }));
  });
  it("deleteheader-index-last", () => {
    expect(
      run(
        'require "editheader"; addheader "X-Test" "first"; addheader :last "X-Test" "second"; deleteheader :index 1 :last "X-Test"; if exists "X-Test" { keep; }',
        eml,
      ),
    ).toEqual(R({ keep: true, implicitKeep: true }));
  });
  it("addheader-case-insensitive-check", () => {
    expect(run('require "editheader"; addheader "x-test" "hello"; if exists "X-TEST" { keep; }', eml)).toEqual(
      R({ keep: true, implicitKeep: true }),
    );
  });
  it("deleteheader-case-insensitive", () => {
    expect(
      run('require "editheader"; deleteheader "SUBJECT"; if not exists "subject" { keep; }', eml),
    ).toEqual(R({ keep: true, implicitKeep: true }));
  });
});

// mailbox — fixture eml
describe("mailbox", () => {
  it("mailboxexists-true", () => {
    expect(run('require "mailbox"; if mailboxexists "INBOX" { keep; }', eml)).toEqual(
      R({ keep: true, implicitKeep: true }),
    );
  });
  it("mailboxexists-multiple", () => {
    expect(run('require "mailbox"; if mailboxexists ["INBOX", "Drafts"] { keep; }', eml)).toEqual(
      R({ keep: true, implicitKeep: true }),
    );
  });
  it("mailboxexists-without-require", () => {
    expect(() => run('if mailboxexists "INBOX" { keep; }', eml)).toThrow();
  });
  it("fileinto-create", () => {
    expect(run('require ["fileinto", "mailbox"]; fileinto :create "NewFolder";', eml)).toEqual(
      R({ fileinto: ["NewFolder"], implicitKeep: false }),
    );
  });
  it("fileinto-create-without-require", () => {
    expect(() => run('require "fileinto"; fileinto :create "NewFolder";', eml)).toThrow();
  });
  it("fileinto-create-and-copy", () => {
    expect(run('require ["fileinto", "mailbox", "copy"]; fileinto :create :copy "NewFolder";', eml)).toEqual(
      R({ fileinto: ["NewFolder"], implicitKeep: true }),
    );
  });
  it("mailboxexists-with-variable", () => {
    expect(
      run('require ["mailbox", "variables"]; set "folder" "INBOX"; if mailboxexists "${folder}" { keep; }', eml),
    ).toEqual(R({ keep: true, implicitKeep: true }));
  });
  it("fileinto-create-with-variable", () => {
    expect(
      run('require ["fileinto", "mailbox", "variables"]; set "folder" "Archive"; fileinto :create "${folder}";', eml),
    ).toEqual(R({ fileinto: ["Archive"], implicitKeep: false }));
  });
  it("fileinto-create-with-flags", () => {
    expect(
      run('require ["fileinto", "mailbox", "imap4flags"]; fileinto :create :flags "\\\\Seen" "Archive";', eml),
    ).toEqual(R({ fileinto: ["Archive"], flags: ["\\seen"], implicitKeep: false }));
  });
  it("mailboxexists-in-condition", () => {
    expect(
      run(
        'require ["fileinto", "mailbox"]; if mailboxexists "Archive" { fileinto "Archive"; } else { fileinto :create "Archive"; }',
        eml,
      ),
    ).toEqual(R({ fileinto: ["Archive"], implicitKeep: false }));
  });
  it("mailboxexists-not", () => {
    expect(run('require "mailbox"; if not mailboxexists "NonExistent" { keep; }', eml)).toEqual(
      R({ implicitKeep: true }),
    );
  });
  it("fileinto-multiple-create", () => {
    expect(
      run('require ["fileinto", "mailbox"]; fileinto :create "Folder1"; fileinto :create "Folder2";', eml),
    ).toEqual(R({ fileinto: ["Folder1", "Folder2"], implicitKeep: false }));
  });
});

// subaddress — fixtures eml (no subaddress) and emlSub (with subaddress)
describe("subaddress", () => {
  it("address-user-no-separator", () => {
    expect(run('require "subaddress"; if address :user "From" "coyote" { keep; }', eml)).toEqual(
      R({ keep: true, implicitKeep: true }),
    );
  });
  it("address-detail-no-separator", () => {
    expect(run('require "subaddress"; if address :detail "From" "" { keep; }', eml)).toEqual(R({ implicitKeep: true }));
  });
  it("subaddress-without-require", () => {
    expect(() => run('if address :user "From" "coyote" { keep; }', eml)).toThrow();
  });
  it("envelope-user", () => {
    expect(run('require ["envelope", "subaddress"]; if envelope :user "from" "from" { keep; }', eml)).toEqual(
      R({ keep: true, implicitKeep: true }),
    );
  });
  it("address-user-with-separator", () => {
    expect(run('require "subaddress"; if address :user "From" "ken" { keep; }', emlSub)).toEqual(
      R({ keep: true, implicitKeep: true }),
    );
  });
  it("address-detail-with-separator", () => {
    expect(run('require "subaddress"; if address :detail "From" "sieve" { keep; }', emlSub)).toEqual(
      R({ keep: true, implicitKeep: true }),
    );
  });
  it("address-detail-to-header", () => {
    expect(run('require "subaddress"; if address :detail "To" "mailing-list" { keep; }', emlSub)).toEqual(
      R({ keep: true, implicitKeep: true }),
    );
  });
  it("address-user-contains", () => {
    expect(run('require "subaddress"; if address :user :contains "From" "k" { keep; }', emlSub)).toEqual(
      R({ keep: true, implicitKeep: true }),
    );
  });
  it("address-detail-contains", () => {
    expect(run('require "subaddress"; if address :detail :contains "From" "siev" { keep; }', emlSub)).toEqual(
      R({ keep: true, implicitKeep: true }),
    );
  });
  it("address-detail-matches", () => {
    expect(run('require "subaddress"; if address :detail :matches "To" "mailing-*" { keep; }', emlSub)).toEqual(
      R({ keep: true, implicitKeep: true }),
    );
  });
  it("address-user-no-match", () => {
    expect(run('require "subaddress"; if address :user "From" "wrong" { keep; }', emlSub)).toEqual(
      R({ implicitKeep: true }),
    );
  });
  it("address-detail-no-match", () => {
    expect(run('require "subaddress"; if address :detail "From" "wrong" { keep; }', emlSub)).toEqual(
      R({ implicitKeep: true }),
    );
  });
  it("address-detail-empty-string", () => {
    expect(run('require "subaddress"; if address :detail "From" "" { keep; }', emlSub)).toEqual(
      R({ implicitKeep: true }),
    );
  });
  it("subaddress-multiple-headers", () => {
    expect(run('require "subaddress"; if address :user ["From", "Cc"] "admin" { keep; }', emlSub)).toEqual(
      R({ keep: true, implicitKeep: true }),
    );
  });
  it("subaddress-detail-multiple-values", () => {
    expect(
      run('require "subaddress"; if address :detail "From" ["other", "sieve", "more"] { keep; }', emlSub),
    ).toEqual(R({ keep: true, implicitKeep: true }));
  });
  it("subaddress-with-fileinto", () => {
    expect(
      run('require ["subaddress", "fileinto"]; if address :detail "To" "mailing-list" { fileinto "lists"; }', emlSub),
    ).toEqual(R({ fileinto: ["lists"], implicitKeep: false }));
  });
  it("subaddress-with-variables", () => {
    const script =
      'require ["subaddress", "fileinto", "mailbox", "variables"]; \n' +
      'if address :detail :matches "To" "*" { \n' +
      '  set :lower "folder" "${1}"; \n' +
      '  fileinto :create "${folder}"; \n' +
      "}";
    expect(run(script, emlSub)).toEqual(R({ fileinto: ["mailing-list"], implicitKeep: false }));
  });
  it("detail-without-require-error", () => {
    expect(() => run('if address :detail "From" "sieve" { keep; }', emlSub)).toThrow();
  });
  it("address-user-case-insensitive", () => {
    expect(run('require "subaddress"; if address :user "From" "KEN" { keep; }', emlSub)).toEqual(
      R({ keep: true, implicitKeep: true }),
    );
  });
  it("address-detail-case-insensitive", () => {
    expect(run('require "subaddress"; if address :detail "From" "SIEVE" { keep; }', emlSub)).toEqual(
      R({ keep: true, implicitKeep: true }),
    );
  });
});

// imap4flags — fixture eml
describe("flags", () => {
  it("set-add-remove", () => {
    expect(
      run(
        'require ["fileinto", "imap4flags"]; setflag ["flag1", "flag2"]; addflag ["flag2", "flag3"]; removeflag ["flag1"]; fileinto "test";',
        eml,
      ),
    ).toEqual(R({ fileinto: ["test"], flags: ["flag2", "flag3"], implicitKeep: false }));
  });
  it("add-remove", () => {
    expect(
      run(
        'require ["fileinto", "imap4flags"]; addflag ["flag2", "flag3"]; removeflag ["flag3", "flag4"]; fileinto "test";',
        eml,
      ),
    ).toEqual(R({ fileinto: ["test"], flags: ["flag2"], implicitKeep: false }));
  });
  it("case-insensitivity", () => {
    expect(run('require "imap4flags"; setflag "Seen"; addflag "FLAGGED"; removeflag "seen"; keep;', eml)).toEqual(
      R({ keep: true, flags: ["flagged"], implicitKeep: true }),
    );
  });
  it("keep-with-flags", () => {
    expect(run('require "imap4flags"; keep :flags ["\\\\Answered", "MyFlag"];', eml)).toEqual(
      R({ keep: true, flags: ["\\answered", "myflag"], implicitKeep: true }),
    );
  });
});
