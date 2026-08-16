// Loaders: turn parsed commands into checked, executable AST nodes, driven by
// the LoadSpec argument engine. A command/test outside the registries below (or
// a `require` for a non-enabled extension) is rejected at load, which is the
// require-gate contract.

import { SieveError } from "../errors.js";
import type { Arg as PArg, Cmd as PCmd, Position, Test as PTest } from "../parser/command.js";
import {
  CmdAddFlag,
  CmdDiscard,
  CmdFileInto,
  CmdKeep,
  CmdRedirect,
  CmdRemoveFlag,
  CmdSetFlag,
  CmdStop,
} from "./action.js";
import { TestBody } from "./body.js";
import { CmdElse, CmdElsif, CmdIf } from "./control.js";
import { CurrentDateTest, DateTest, type DatePart, parseZoneOffset, VALID_DATE_PARTS } from "./date.js";
import {
  CmdDovecotConfigSet,
  CmdDovecotNoop,
  CmdDovecotTest,
  CmdDovecotTestFail,
  CmdDovecotTestSet,
  TestDovecotCompile,
  TestDovecotRun,
  TestDovecotTestError,
} from "./dovecot-testsuite.js";
import { CmdAddHeader, CmdDeleteHeader } from "./editheader.js";
import { decodeEncodedChars } from "./encoded.js";
import { MailboxExistsTest } from "./mailbox.js";
import { MatcherTest } from "./matcher.js";
import { CmdVacation } from "./vacation.js";
import { CmdSet, SET_MODIFIERS, TestString } from "./variables.js";
import type { AddressPart } from "./matching.js";
import type { Cmd, Test } from "./runtime.js";
import type { Script } from "./script.js";
import type { Spec, SpecTag } from "./spec.js";
import {
  AddressTest,
  AllOfTest,
  AnyOfTest,
  EnvelopeTest,
  ExistsTest,
  FalseTest,
  HasFlagTest,
  HeaderTest,
  NotTest,
  SizeTest,
  TrueTest,
} from "./test.js";

/**
 * Sieve extensions the library actually IMPLEMENTS. A `require` for a name
 * outside this set is rejected at load ("unsupported extension"), so extensions
 * not yet implemented fail RED until their loaders + runtime land, at which
 * point their name is added here.
 */
const supportedRequires = new Set([
  "fileinto",
  "envelope",
  "imap4flags",
  "subaddress",
  "copy",
  "comparator-i;octet",
  "comparator-i;ascii-casemap",
  "comparator-i;ascii-numeric",
  "comparator-i;unicode-casemap",
  "mailbox",
  "editheader",
  "date",
  "index",
  "relational",
  "variables",
  "regex",
  "encoded-character",
  "body",
  "vacation",
]);

function at(pos: Position, message: string): SieveError {
  return new SieveError(message, { line: pos.line, col: pos.col });
}

// ---------------------------------------------------------------------------
// LoadSpec — generic argument loader. Both `encoded-character` and `variables`
// are supported (see supportedRequires): this branches on the former, and
// variable-name length is enforced in interp/variables.ts.
// ---------------------------------------------------------------------------

function loadSpec(
  s: Script,
  spec: Spec,
  position: Position,
  args: PArg[],
  tests: PTest[],
  block: PCmd[] | null,
): void {
  const pos = spec.pos ?? [];
  // RFC 5228 §2.4.2.4: decode ${hex:}/${unicode:} in string args at load time.
  const dec: (v: string[]) => string[] = s.requiresExtension("encoded-character")
    ? (v) => v.map(decodeEncodedChars)
    : (v) => v;
  let lastTag: SpecTag | null = null;
  let nextPosArg = 0;

  for (const a of args) {
    switch (a.kind) {
      case "string": {
        if (lastTag && lastTag.needsValue) {
          if (lastTag.matchNum) throw at(a, "LoadSpec: tagged argument requires a number, got string");
          else if (lastTag.matchStr) lastTag.matchStr(dec([a.value]));
          else throw new SieveError("missing matcher for SpecTag");
          lastTag = null;
          continue;
        }
        if (nextPosArg >= pos.length) throw at(a, "LoadSpec: too many arguments");
        const p = pos[nextPosArg]!;
        if ((p.minStrCount ?? 0) > 1) throw at(a, "LoadSpec: string-list required, got single string");
        if (p.matchNum) throw at(a, "LoadSpec: argument requires a number, got string-list");
        else if (p.matchStr) p.matchStr(dec([a.value]));
        else throw new SieveError("no pos matcher");
        nextPosArg++;
        break;
      }
      case "stringList": {
        if (lastTag && lastTag.needsValue) {
          if (lastTag.matchNum) throw at(a, "LoadSpec: tagged argument requires a number, got string-list");
          else if (lastTag.matchStr) {
            if (
              ((lastTag.minStrCount ?? 0) !== 0 && a.value.length < (lastTag.minStrCount ?? 0)) ||
              ((lastTag.maxStrCount ?? 0) !== 0 && a.value.length > (lastTag.maxStrCount ?? 0))
            ) {
              throw at(a, "LoadSpec: wrong amount of string arguments");
            }
            lastTag.matchStr(dec(a.value));
          } else throw new SieveError("missing matcher for SpecTag");
          lastTag = null;
          continue;
        }
        if (nextPosArg >= pos.length) throw at(a, "LoadSpec: too many arguments");
        const p = pos[nextPosArg]!;
        if (
          ((p.minStrCount ?? 0) !== 0 && a.value.length < (p.minStrCount ?? 0)) ||
          ((p.maxStrCount ?? 0) !== 0 && a.value.length > (p.maxStrCount ?? 0))
        ) {
          throw at(a, "LoadSpec: wrong amount of string arguments");
        }
        if (p.matchNum) throw at(a, "LoadSpec: argument requires a number, got string-list");
        else if (p.matchStr) p.matchStr(dec(a.value));
        else throw new SieveError("no pos matcher");
        nextPosArg++;
        break;
      }
      case "number": {
        if (lastTag && lastTag.needsValue) {
          if (lastTag.matchStr) throw at(a, "LoadSpec: tagged argument requires a string-list, got number");
          else if (lastTag.matchNum) lastTag.matchNum(a.value);
          else throw new SieveError("missing matcher for SpecTag");
          lastTag = null;
          continue;
        }
        if (nextPosArg >= pos.length) throw at(a, "LoadSpec: too many arguments");
        const p = pos[nextPosArg]!;
        if (p.matchStr) throw at(a, "LoadSpec: argument requires a string-list, got number");
        else if (p.matchNum) p.matchNum(a.value);
        else throw new SieveError("no pos matcher");
        nextPosArg++;
        break;
      }
      case "tag": {
        if (lastTag && lastTag.needsValue) throw at(a, "LoadSpec: tagged argument requires a value");
        const tag = spec.tags?.[a.value.toLowerCase()];
        if (!tag) throw at(a, `LoadSpec: unknown tagged argument: ${a.value}`);
        if (tag.needsValue) lastTag = tag;
        else tag.matchBool!();
        break;
      }
    }
  }

  for (let i = nextPosArg; i < pos.length; i++) {
    if (!pos[i]!.optional) throw at(position, `LoadSpec: ${i + 1} argument is required`);
  }

  if (!spec.addTest) {
    if (tests.length !== 0) throw at(position, "LoadSpec: no tests allowed");
  } else {
    if (tests.length === 0 && !spec.testOptional) throw at(position, "LoadSpec: at least one test required");
    if (tests.length > 1 && !spec.multipleTests) throw at(position, "LoadSpec: only one test allowed");
    for (const t of tests) spec.addTest(loadTest(s, t));
  }

  if (spec.addBlock) {
    if (block !== null) spec.addBlock(loadBlock(s, block));
    else if (!spec.blockOptional) throw at(position, "LoadSpec: block is required");
  } else if (block !== null) {
    throw at(position, "LoadSpec: no block allowed");
  }
}

// ---------------------------------------------------------------------------
// Command loaders
// ---------------------------------------------------------------------------

function loadRequire(s: Script, pcmd: PCmd): Cmd | null {
  let exts: string[] = [];
  loadSpec(
    s,
    { pos: [{ optional: false, minStrCount: 1, matchStr: (val) => (exts = val) }] },
    pcmd,
    pcmd.args,
    pcmd.tests,
    pcmd.block,
  );
  for (const ext of exts) {
    if (ext === DOVECOT_TEST_EXTENSION) {
      // The testsuite gate: allowed only when a test environment is present, and
      // it bypasses supportedRequires / enabledExtensions entirely.
      if (!s.opts.testEnv) {
        throw new SieveError("testing environment is not available, cannot use vnd.dovecot.testsuite");
      }
      s.extensions.add(ext);
      continue;
    }
    if (!supportedRequires.has(ext)) throw new SieveError(`loadRequire: unsupported extension: ${ext}`);
    if (s.enabledExtensions === null || !s.enabledExtensions.includes(ext)) {
      throw new SieveError(`extension '${ext}' is not supported`);
    }
    s.extensions.add(ext);
  }
  return null;
}

const DOVECOT_TEST_EXTENSION = "vnd.dovecot.testsuite";

/** Re-gate for `test`/`test_set`/`test_fail` loaders. */
function ensureTestEnv(s: Script): void {
  if (!s.requiresExtension(DOVECOT_TEST_EXTENSION) || !s.opts.testEnv) {
    throw new SieveError("testing environment is not enabled");
  }
}

function loadIf(s: Script, pcmd: PCmd): Cmd {
  const cmd = new CmdIf();
  loadSpec(
    s,
    { addTest: (t) => (cmd.test = t), addBlock: (cmds) => (cmd.block = cmds) },
    pcmd,
    pcmd.args,
    pcmd.tests,
    pcmd.block,
  );
  return cmd;
}

function loadElsif(s: Script, pcmd: PCmd): Cmd {
  const cmd = new CmdElsif();
  loadSpec(
    s,
    { addTest: (t) => (cmd.test = t), addBlock: (cmds) => (cmd.block = cmds) },
    pcmd,
    pcmd.args,
    pcmd.tests,
    pcmd.block,
  );
  return cmd;
}

function loadElse(s: Script, pcmd: PCmd): Cmd {
  const cmd = new CmdElse();
  loadSpec(s, { addBlock: (cmds) => (cmd.block = cmds) }, pcmd, pcmd.args, pcmd.tests, pcmd.block);
  return cmd;
}

function loadStop(s: Script, pcmd: PCmd): Cmd {
  loadSpec(s, {}, pcmd, pcmd.args, pcmd.tests, pcmd.block);
  return new CmdStop();
}

function loadFileInto(s: Script, pcmd: PCmd): Cmd {
  if (!s.requiresExtension("fileinto")) throw at(pcmd, "missing require 'fileinto'");
  const cmd = new CmdFileInto();
  loadSpec(
    s,
    {
      tags: {
        flags: { needsValue: true, minStrCount: 1, matchStr: (val) => (cmd.flags = canonical(val)) },
        copy: { matchBool: () => (cmd.copy = true) },
        create: { matchBool: () => (cmd.create = true) },
      },
      pos: [{ minStrCount: 1, maxStrCount: 1, matchStr: (val) => (cmd.mailbox = val[0]!) }],
    },
    pcmd,
    pcmd.args,
    pcmd.tests,
    pcmd.block,
  );
  if (!s.requiresExtension("imap4flags") && cmd.flags !== null) throw at(pcmd, "missing require 'imap4flags'");
  if (cmd.copy && !s.requiresExtension("copy")) throw at(pcmd, "missing require 'copy'");
  if (cmd.create && !s.requiresExtension("mailbox")) throw at(pcmd, "missing require 'mailbox'");
  return cmd;
}

function loadRedirect(s: Script, pcmd: PCmd): Cmd {
  const cmd = new CmdRedirect();
  loadSpec(
    s,
    {
      tags: { copy: { matchBool: () => (cmd.copy = true) } },
      pos: [{ minStrCount: 1, maxStrCount: 1, matchStr: (val) => (cmd.addr = val[0]!) }],
    },
    pcmd,
    pcmd.args,
    pcmd.tests,
    pcmd.block,
  );
  if (cmd.copy && !s.requiresExtension("copy")) throw at(pcmd, "missing require 'copy'");
  return cmd;
}

function loadKeep(s: Script, pcmd: PCmd): Cmd {
  const cmd = new CmdKeep();
  loadSpec(
    s,
    { tags: { flags: { needsValue: true, minStrCount: 1, matchStr: (val) => (cmd.flags = canonical(val)) } } },
    pcmd,
    pcmd.args,
    pcmd.tests,
    pcmd.block,
  );
  if (!s.requiresExtension("imap4flags") && cmd.flags !== null) throw at(pcmd, "missing require 'imap4flags'");
  return cmd;
}

function loadDiscard(s: Script, pcmd: PCmd): Cmd {
  loadSpec(s, {}, pcmd, pcmd.args, pcmd.tests, pcmd.block);
  return new CmdDiscard();
}

/**
 * RFC 5232 §5: `setflag`/`addflag`/`removeflag [<variablename>] <list-of-flags>`.
 * With one positional the command acts on the internal flag set; with two, the
 * first is a variable name and the flags are stored in (order-preserving) that
 * variable. Flags are kept RAW here (canonicalised at execution, preserving order
 * for the variable form).
 */
function loadFlagCmd(
  s: Script,
  pcmd: PCmd,
  cmd: { variableName: string | null; flags: string[] | null },
): { variableName: string | null; flags: string[] | null } {
  if (!s.requiresExtension("imap4flags")) throw at(pcmd, "missing require 'imap4flags'");
  let first: string[] = [];
  let second: string[] | null = null;
  loadSpec(
    s,
    {
      pos: [
        { minStrCount: 1, matchStr: (val) => (first = val) },
        { optional: true, minStrCount: 1, matchStr: (val) => (second = val) },
      ],
    },
    pcmd,
    pcmd.args,
    pcmd.tests,
    pcmd.block,
  );
  if (second !== null) {
    if (first.length !== 1) throw at(pcmd, "imap4flags: variable name must be a single string");
    if (!s.requiresExtension("variables")) throw at(pcmd, "missing require 'variables'");
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(first[0]!)) throw at(pcmd, `imap4flags: invalid variable name: ${first[0]}`);
    cmd.variableName = first[0]!;
    cmd.flags = second;
  } else {
    cmd.flags = first;
  }
  return cmd;
}

function loadSetFlag(s: Script, pcmd: PCmd): Cmd {
  return loadFlagCmd(s, pcmd, new CmdSetFlag()) as CmdSetFlag;
}
function loadAddFlag(s: Script, pcmd: PCmd): Cmd {
  return loadFlagCmd(s, pcmd, new CmdAddFlag()) as CmdAddFlag;
}
function loadRemoveFlag(s: Script, pcmd: PCmd): Cmd {
  return loadFlagCmd(s, pcmd, new CmdRemoveFlag()) as CmdRemoveFlag;
}

// ---------------------------------------------------------------------------
// Test loaders
// ---------------------------------------------------------------------------

function loadAddressTest(s: Script, ptest: PTest): Test {
  const matcher = new MatcherTest();
  let addressPart: AddressPart = "all";
  let addressPartCnt = 0;
  let header: string[] = [];
  let key: string[] = [];
  let useSubaddress = false;
  let index = 0;
  let last = false;
  const spec = matcher.addSpecTags({
    tags: {
      all: { matchBool: () => ((addressPart = "all"), addressPartCnt++) },
      localpart: { matchBool: () => ((addressPart = "localpart"), addressPartCnt++) },
      domain: { matchBool: () => ((addressPart = "domain"), addressPartCnt++) },
      user: { matchBool: () => ((addressPart = "user"), addressPartCnt++, (useSubaddress = true)) },
      detail: { matchBool: () => ((addressPart = "detail"), addressPartCnt++, (useSubaddress = true)) },
      index: { needsValue: true, matchNum: (n) => (index = n) },
      last: { matchBool: () => (last = true) },
    },
    pos: [
      { minStrCount: 1, matchStr: (val) => (header = val) },
      { minStrCount: 1, matchStr: (val) => (key = val) },
    ],
  });
  loadSpec(s, spec, ptest, ptest.args, ptest.tests, null);
  matcher.setKey(s, key);
  if (addressPartCnt > 1) throw new SieveError("multiple address-parts are not allowed");
  if (useSubaddress && !s.requiresExtension("subaddress")) throw at(ptest, "missing require 'subaddress'");
  checkIndexTags(s, ptest, "address", index, last);
  const t = new AddressTest(matcher, addressPart, header);
  t.index = index;
  t.last = last;
  return t;
}

/** RFC 5260 §6: `:index` needs require "index"; `:last` needs `:index`. */
function checkIndexTags(s: Script, pos: Position, what: string, index: number, last: boolean): void {
  if (last && index === 0) throw at(pos, `${what}: :last can only be specified with :index`);
  if (index > 0 && !s.requiresExtension("index")) {
    throw at(pos, `${what}: missing require 'index' for :index argument`);
  }
}

function loadEnvelopeTest(s: Script, ptest: PTest): Test {
  if (!s.requiresExtension("envelope")) throw new SieveError("missing require 'envelope'");
  const matcher = new MatcherTest();
  let addressPart: AddressPart = "all";
  let field: string[] = [];
  let key: string[] = [];
  let useSubaddress = false;
  const spec = matcher.addSpecTags({
    tags: {
      all: { matchBool: () => (addressPart = "all") },
      localpart: { matchBool: () => (addressPart = "localpart") },
      domain: { matchBool: () => (addressPart = "domain") },
      user: { matchBool: () => ((addressPart = "user"), (useSubaddress = true)) },
      detail: { matchBool: () => ((addressPart = "detail"), (useSubaddress = true)) },
    },
    pos: [
      { minStrCount: 1, matchStr: (val) => (field = val) },
      { minStrCount: 1, matchStr: (val) => (key = val) },
    ],
  });
  loadSpec(s, spec, ptest, ptest.args, ptest.tests, null);
  matcher.setKey(s, key);
  if (useSubaddress && !s.requiresExtension("subaddress")) throw at(ptest, "missing require 'subaddress'");
  return new EnvelopeTest(matcher, addressPart, field);
}

function loadHeaderTest(s: Script, ptest: PTest): Test {
  const matcher = new MatcherTest();
  let header: string[] = [];
  let key: string[] = [];
  let index = 0;
  let last = false;
  const spec = matcher.addSpecTags({
    tags: {
      index: { needsValue: true, matchNum: (n) => (index = n) },
      last: { matchBool: () => (last = true) },
    },
    pos: [
      { minStrCount: 1, matchStr: (val) => (header = val) },
      { minStrCount: 1, matchStr: (val) => (key = val) },
    ],
  });
  loadSpec(s, spec, ptest, ptest.args, ptest.tests, null);
  matcher.setKey(s, key);
  checkIndexTags(s, ptest, "header", index, last);
  const t = new HeaderTest(matcher, header);
  t.index = index;
  t.last = last;
  return t;
}

/**
 * RFC 5232 §5 hasflag. Two positional forms:
 *   hasflag <list-of-flags>
 *   hasflag <variable-list> <list-of-flags>   (needs `variables`)
 */
function loadHasFlagTest(s: Script, ptest: PTest): Test {
  if (!s.requiresExtension("imap4flags")) throw at(ptest, "missing require 'imap4flags'");
  const matcher = new MatcherTest();
  let first: string[] = [];
  let second: string[] | null = null;
  const spec = matcher.addSpecTags({
    pos: [
      { minStrCount: 1, matchStr: (val) => (first = val) },
      { optional: true, minStrCount: 1, matchStr: (val) => (second = val) },
    ],
  });
  loadSpec(s, spec, ptest, ptest.args, ptest.tests, null);
  let variables: string[] = [];
  let key = first;
  if (second !== null) {
    variables = first;
    key = second;
    if (!s.requiresExtension("variables")) throw at(ptest, "hasflag: missing require 'variables'");
    for (const v of variables) {
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(v)) throw at(ptest, `hasflag: invalid variable name: ${v}`);
    }
  }
  // RFC 5232 §5: the flag set matches if any of its flags matches any flag NAME
  // in the key list — so each key string is a space-separated list of flags,
  // split into individual flags. (For :count the keys are numeric thresholds.)
  if (matcher.match !== "count") {
    key = key.flatMap((k) => k.split(" ").filter((x) => x !== ""));
  }
  matcher.setKey(s, key);
  return new HasFlagTest(matcher, variables);
}

function loadExistsTest(s: Script, ptest: PTest): Test {
  let fields: string[] = [];
  loadSpec(
    s,
    { pos: [{ minStrCount: 1, matchStr: (val) => (fields = val) }] },
    ptest,
    ptest.args,
    ptest.tests,
    null,
  );
  return new ExistsTest(fields);
}

function loadFalseTest(s: Script, ptest: PTest): Test {
  loadSpec(s, {}, ptest, ptest.args, ptest.tests, null);
  return new FalseTest();
}

function loadTrueTest(s: Script, ptest: PTest): Test {
  loadSpec(s, {}, ptest, ptest.args, ptest.tests, null);
  return new TrueTest();
}

function loadNotTest(s: Script, ptest: PTest): Test {
  const not = new NotTest(new TrueTest());
  loadSpec(s, { addTest: (t) => (not.test = t) }, ptest, ptest.args, ptest.tests, null);
  return not;
}

function loadAllOfTest(s: Script, ptest: PTest): Test {
  const t = new AllOfTest([]);
  loadSpec(s, { addTest: (x) => t.tests.push(x), multipleTests: true }, ptest, ptest.args, ptest.tests, null);
  return t;
}

function loadAnyOfTest(s: Script, ptest: PTest): Test {
  const t = new AnyOfTest([]);
  loadSpec(s, { addTest: (x) => t.tests.push(x), multipleTests: true }, ptest, ptest.args, ptest.tests, null);
  return t;
}

function loadAddHeader(s: Script, pcmd: PCmd): Cmd {
  if (!s.requiresExtension("editheader")) throw at(pcmd, "missing require 'editheader'");
  const cmd = new CmdAddHeader();
  loadSpec(
    s,
    {
      tags: { last: { matchBool: () => (cmd.last = true) } },
      pos: [
        { minStrCount: 1, maxStrCount: 1, matchStr: (v) => (cmd.fieldName = v[0]!) },
        { minStrCount: 1, maxStrCount: 1, matchStr: (v) => (cmd.value = v[0]!) },
      ],
    },
    pcmd,
    pcmd.args,
    pcmd.tests,
    pcmd.block,
  );
  return cmd;
}

function loadDeleteHeader(s: Script, pcmd: PCmd): Cmd {
  if (!s.requiresExtension("editheader")) throw at(pcmd, "missing require 'editheader'");
  const cmd = new CmdDeleteHeader();
  const spec = cmd.matcher.addSpecTags({
    tags: {
      index: { needsValue: true, matchNum: (n) => (cmd.index = n) },
      last: { matchBool: () => (cmd.last = true) },
    },
    pos: [
      { minStrCount: 1, maxStrCount: 1, matchStr: (v) => (cmd.fieldName = v[0]!) },
      { optional: true, minStrCount: 1, matchStr: (v) => (cmd.valuePatterns = v) },
    ],
  });
  loadSpec(s, spec, pcmd, pcmd.args, pcmd.tests, pcmd.block);
  if (cmd.last && cmd.index === 0) throw at(pcmd, ":last can only be specified with :index");
  if (cmd.valuePatterns.length > 0) {
    try {
      cmd.matcher.setKey(s, cmd.valuePatterns);
    } catch (e) {
      throw new SieveError(`deleteheader: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return cmd;
}

function loadDateTest(s: Script, ptest: PTest): Test {
  if (!s.requiresExtension("date")) throw new SieveError("missing require 'date'");
  const t = new DateTest();
  let zoneCnt = 0;
  let key: string[] = [];
  const spec = t.matcher.addSpecTags({
    tags: {
      zone: { needsValue: true, minStrCount: 1, maxStrCount: 1, matchStr: (v) => ((t.zone = v[0]!), zoneCnt++) },
      originalzone: { matchBool: () => ((t.originalZone = true), zoneCnt++) },
      index: { needsValue: true, matchNum: (n) => (t.index = n) },
      last: { matchBool: () => (t.last = true) },
    },
    pos: [
      { minStrCount: 1, maxStrCount: 1, matchStr: (v) => (t.header = v[0]!) },
      { minStrCount: 1, maxStrCount: 1, matchStr: (v) => (t.datePart = v[0]!.toLowerCase() as DatePart) },
      { minStrCount: 1, matchStr: (v) => (key = v) },
    ],
  });
  loadSpec(s, spec, ptest, ptest.args, ptest.tests, null);
  if (zoneCnt > 1) throw new SieveError("date: cannot specify both :zone and :originalzone");
  if (t.zone !== "") {
    try {
      parseZoneOffset(t.zone);
    } catch (e) {
      throw new SieveError(`date: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (!VALID_DATE_PARTS.has(t.datePart)) throw new SieveError(`date: invalid date-part: ${t.datePart}`);
  if (t.last && t.index === 0) throw new SieveError("date: :last requires :index");
  if (t.index > 0 && !s.requiresExtension("index")) {
    throw new SieveError("date: missing require 'index' for :index argument");
  }
  t.matcher.setKey(s, key);
  return t;
}

function loadCurrentDateTest(s: Script, ptest: PTest): Test {
  if (!s.requiresExtension("date")) throw new SieveError("missing require 'date'");
  const t = new CurrentDateTest();
  let key: string[] = [];
  const spec = t.matcher.addSpecTags({
    tags: {
      zone: { needsValue: true, minStrCount: 1, maxStrCount: 1, matchStr: (v) => (t.zone = v[0]!) },
    },
    pos: [
      { minStrCount: 1, maxStrCount: 1, matchStr: (v) => (t.datePart = v[0]!.toLowerCase() as DatePart) },
      { minStrCount: 1, matchStr: (v) => (key = v) },
    ],
  });
  loadSpec(s, spec, ptest, ptest.args, ptest.tests, null);
  if (t.zone !== "") {
    try {
      parseZoneOffset(t.zone);
    } catch (e) {
      throw new SieveError(`currentdate: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (!VALID_DATE_PARTS.has(t.datePart)) throw new SieveError(`currentdate: invalid date-part: ${t.datePart}`);
  t.matcher.setKey(s, key);
  return t;
}

function loadVacation(s: Script, pcmd: PCmd): Cmd {
  if (!s.requiresExtension("vacation")) throw at(pcmd, "missing require 'vacation'");
  const cmd = new CmdVacation();
  loadSpec(
    s,
    {
      tags: {
        days: { needsValue: true, matchNum: (n) => (cmd.days = n) },
        subject: { needsValue: true, minStrCount: 1, maxStrCount: 1, matchStr: (v) => (cmd.subject = v[0]!) },
        from: { needsValue: true, minStrCount: 1, maxStrCount: 1, matchStr: (v) => (cmd.from = v[0]!) },
        addresses: { needsValue: true, minStrCount: 1, matchStr: (v) => (cmd.addresses = v) },
        mime: { matchBool: () => (cmd.mime = true) },
        handle: { needsValue: true, minStrCount: 1, maxStrCount: 1, matchStr: (v) => (cmd.handle = v[0]!) },
      },
      pos: [{ minStrCount: 1, maxStrCount: 1, matchStr: (v) => (cmd.reason = v[0]!) }],
    },
    pcmd,
    pcmd.args,
    pcmd.tests,
    pcmd.block,
  );
  return cmd;
}

function loadSet(s: Script, pcmd: PCmd): Cmd {
  if (!s.requiresExtension("variables")) throw at(pcmd, "missing require 'variables'");
  const cmd = new CmdSet();
  loadSpec(
    s,
    {
      tags: {
        lower: { matchBool: () => cmd.modifiers.push("lower") },
        upper: { matchBool: () => cmd.modifiers.push("upper") },
        lowerfirst: { matchBool: () => cmd.modifiers.push("lowerfirst") },
        upperfirst: { matchBool: () => cmd.modifiers.push("upperfirst") },
        quotewildcard: { matchBool: () => cmd.modifiers.push("quotewildcard") },
        length: { matchBool: () => cmd.modifiers.push("length") },
      },
      pos: [
        { minStrCount: 1, maxStrCount: 1, matchStr: (v) => (cmd.name = v[0]!) },
        { minStrCount: 1, maxStrCount: 1, matchStr: (v) => (cmd.value = v[0]!) },
      ],
    },
    pcmd,
    pcmd.args,
    pcmd.tests,
    pcmd.block,
  );
  // Same-precedence-tier modifiers conflict (e.g. :lower + :upper).
  const tiers = cmd.modifiers.map((m) => SET_MODIFIERS[m]!.precedence);
  if (new Set(tiers).size !== tiers.length) throw at(pcmd, "set: conflicting modifiers");
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(cmd.name)) throw at(pcmd, `set: invalid variable name: ${cmd.name}`);
  return cmd;
}

function loadStringTest(s: Script, ptest: PTest): Test {
  if (!s.requiresExtension("variables")) throw new SieveError("missing require 'variables'");
  const t = new TestString();
  let key: string[] = [];
  const spec = t.matcher.addSpecTags({
    pos: [
      { minStrCount: 1, matchStr: (v) => (t.source = v) },
      { minStrCount: 1, matchStr: (v) => (key = v) },
    ],
  });
  loadSpec(s, spec, ptest, ptest.args, ptest.tests, null);
  t.matcher.setKey(s, key);
  return t;
}

function loadBodyTest(s: Script, ptest: PTest): Test {
  if (!s.requiresExtension("body")) throw new SieveError("missing require 'body'");
  const t = new TestBody();
  let transformCount = 0;
  let key: string[] = [];
  const spec = t.matcher.addSpecTags({
    tags: {
      raw: { matchBool: () => ((t.raw = true), transformCount++) },
      text: { matchBool: () => ((t.text = true), transformCount++) },
      content: { needsValue: true, minStrCount: 1, matchStr: (v) => ((t.content = v), transformCount++) },
    },
    pos: [{ minStrCount: 1, matchStr: (v) => (key = v) }],
  });
  loadSpec(s, spec, ptest, ptest.args, ptest.tests, null);
  if (transformCount > 1) throw new SieveError("only one of :raw, :text, or :content is allowed");
  if (transformCount === 0) t.text = true;
  t.matcher.setKey(s, key);
  return t;
}

function loadMailboxExistsTest(s: Script, ptest: PTest): Test {
  if (!s.requiresExtension("mailbox")) throw new SieveError("missing require 'mailbox'");
  let mailboxes: string[] = [];
  loadSpec(
    s,
    { pos: [{ minStrCount: 1, matchStr: (val) => (mailboxes = val) }] },
    ptest,
    ptest.args,
    ptest.tests,
    null,
  );
  return new MailboxExistsTest(mailboxes);
}

function loadSizeTest(s: Script, ptest: PTest): Test {
  const t = new SizeTest(0, false, false);
  loadSpec(
    s,
    {
      tags: {
        under: { matchBool: () => (t.under = true) },
        over: { matchBool: () => (t.over = true) },
      },
      pos: [{ matchNum: (i) => (t.size = i) }],
    },
    ptest,
    ptest.args,
    ptest.tests,
    null,
  );
  if (t.under === t.over) throw new SieveError("loadSizeTest: either under or over is required");
  return t;
}

// canonicalFlags at load time (no aliases).
import { canonicalFlags } from "./action.js";
function canonical(val: string[]): string[] {
  return canonicalFlags(val, null);
}

// ---------------------------------------------------------------------------
// vnd.dovecot.testsuite loaders. Registered unconditionally;
// the gated commands re-check the test environment at load, so a script without
// `require "vnd.dovecot.testsuite"` (or without Options.testEnv) is rejected.
// ---------------------------------------------------------------------------

function loadDovecotTest(s: Script, pcmd: PCmd): Cmd {
  ensureTestEnv(s);
  const cmd = new CmdDovecotTest();
  loadSpec(
    s,
    {
      pos: [{ minStrCount: 1, maxStrCount: 1, matchStr: (v) => (cmd.testName = v[0]!) }],
      addBlock: (cmds) => (cmd.cmds = cmds),
    },
    pcmd,
    pcmd.args,
    pcmd.tests,
    pcmd.block,
  );
  return cmd;
}

function loadDovecotTestSet(s: Script, pcmd: PCmd): Cmd {
  ensureTestEnv(s);
  const cmd = new CmdDovecotTestSet();
  loadSpec(
    s,
    {
      pos: [
        { minStrCount: 1, maxStrCount: 1, noVariables: true, matchStr: (v) => (cmd.variableName = v[0]!) },
        { minStrCount: 1, maxStrCount: 1, matchStr: (v) => (cmd.variableValue = v[0]!) },
      ],
    },
    pcmd,
    pcmd.args,
    pcmd.tests,
    pcmd.block,
  );
  return cmd;
}

function loadDovecotTestFail(s: Script, pcmd: PCmd): Cmd {
  ensureTestEnv(s);
  const cmd = new CmdDovecotTestFail();
  loadSpec(
    s,
    { pos: [{ minStrCount: 1, maxStrCount: 1, matchStr: (v) => (cmd.message = v[0]!) }] },
    pcmd,
    pcmd.args,
    pcmd.tests,
    pcmd.block,
  );
  cmd.at = { line: pcmd.line, col: pcmd.col };
  return cmd;
}

function loadDovecotConfigSet(s: Script, pcmd: PCmd): Cmd {
  const cmd = new CmdDovecotConfigSet(false);
  loadSpec(
    s,
    {
      pos: [
        { minStrCount: 1, maxStrCount: 1, matchStr: (v) => (cmd.key = v[0]!) },
        { minStrCount: 1, maxStrCount: 1, matchStr: (v) => (cmd.value = v[0]!) },
      ],
    },
    pcmd,
    pcmd.args,
    pcmd.tests,
    pcmd.block,
  );
  return cmd;
}

function loadDovecotConfigUnset(s: Script, pcmd: PCmd): Cmd {
  const cmd = new CmdDovecotConfigSet(true);
  loadSpec(
    s,
    {
      pos: [
        { minStrCount: 1, maxStrCount: 1, matchStr: (v) => (cmd.key = v[0]!) },
        { minStrCount: 1, maxStrCount: 1, matchStr: (v) => (cmd.value = v[0]!) },
      ],
    },
    pcmd,
    pcmd.args,
    pcmd.tests,
    pcmd.block,
  );
  return cmd;
}

function loadDovecotNoop(_s: Script, _pcmd: PCmd): Cmd {
  // loadNoop ignores args entirely (no LoadSpec).
  return new CmdDovecotNoop();
}

function loadDovecotCompile(s: Script, ptest: PTest): Test {
  const t = new TestDovecotCompile();
  loadSpec(
    s,
    { pos: [{ minStrCount: 1, maxStrCount: 1, matchStr: (v) => (t.scriptPath = v[0]!) }] },
    ptest,
    ptest.args,
    ptest.tests,
    null,
  );
  return t;
}

function loadDovecotRun(s: Script, ptest: PTest): Test {
  loadSpec(s, {}, ptest, ptest.args, ptest.tests, null);
  return new TestDovecotRun();
}

function loadDovecotError(s: Script, ptest: PTest): Test {
  // test_error is always true; accept + discard :index, the matcher tags, and
  // one required key argument (Pigeonhole-specific detail checks are dropped).
  const matcher = new MatcherTest();
  const spec = matcher.addSpecTags({
    tags: { index: { needsValue: true, minStrCount: 1, maxStrCount: 1, noVariables: true, matchNum: () => {} } },
    pos: [{ minStrCount: 1, matchStr: () => {} }],
  });
  loadSpec(s, spec, ptest, ptest.args, ptest.tests, null);
  return new TestDovecotTestError();
}

// ---------------------------------------------------------------------------
// Registries + top-level loaders
// ---------------------------------------------------------------------------

const commands: Record<string, (s: Script, cmd: PCmd) => Cmd | null> = {
  require: loadRequire,
  if: loadIf,
  elsif: loadElsif,
  else: loadElse,
  stop: loadStop,
  fileinto: loadFileInto,
  redirect: loadRedirect,
  keep: loadKeep,
  discard: loadDiscard,
  setflag: loadSetFlag,
  addflag: loadAddFlag,
  removeflag: loadRemoveFlag,
  addheader: loadAddHeader,
  deleteheader: loadDeleteHeader,
  set: loadSet,
  vacation: loadVacation,
  // vnd.dovecot.testsuite
  test: loadDovecotTest,
  test_set: loadDovecotTestSet,
  test_fail: loadDovecotTestFail,
  test_config_set: loadDovecotConfigSet,
  test_config_unset: loadDovecotConfigUnset,
  test_binary_load: loadDovecotNoop, // no intermediate binary representation
  test_binary_save: loadDovecotNoop,
  test_config_reload: loadDovecotNoop, // config changes apply immediately
};

const tests: Record<string, (s: Script, t: PTest) => Test> = {
  address: loadAddressTest,
  allof: loadAllOfTest,
  anyof: loadAnyOfTest,
  envelope: loadEnvelopeTest,
  exists: loadExistsTest,
  false: loadFalseTest,
  true: loadTrueTest,
  hasflag: loadHasFlagTest,
  header: loadHeaderTest,
  not: loadNotTest,
  size: loadSizeTest,
  mailboxexists: loadMailboxExistsTest,
  date: loadDateTest,
  currentdate: loadCurrentDateTest,
  string: loadStringTest,
  body: loadBodyTest,
  // vnd.dovecot.testsuite
  test_script_compile: loadDovecotCompile,
  test_script_run: loadDovecotRun,
  test_error: loadDovecotError,
};

export function loadBlock(s: Script, cmds: PCmd[]): Cmd[] {
  const loaded: Cmd[] = [];
  for (const c of cmds) {
    const cmd = loadCmd(s, c);
    if (cmd === null) continue;
    loaded.push(cmd);
  }
  return loaded;
}

function loadCmd(s: Script, cmd: PCmd): Cmd | null {
  const factory = commands[cmd.id.toLowerCase()];
  if (!factory) throw at(cmd, `unsupported command: ${cmd.id.toLowerCase()}`);
  return factory(s, cmd);
}

function loadTest(s: Script, t: PTest): Test {
  const factory = tests[t.id.toLowerCase()];
  if (!factory) throw at(t, `unsupported test: ${t.id.toLowerCase()}`);
  return factory(s, t);
}
