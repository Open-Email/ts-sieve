// #65: an uncertain recoverable effect must not make an independent local
// drop uncertain. A possibly missed local store must still prevent the drop.
import { describe, expect, it } from "vitest";
import { DummyPolicy, EnvelopeStatic, load, MessageStatic, newRuntimeData } from "../src/index.js";
import { ALL_EXTENSIONS, parseEml } from "./harness.js";

const REQUIRE = 'require ["foreverypart", "mime", "imap4flags", "fileinto", "variables", "editheader", "reject", "vacation", "copy"];';
const DISCARD = 'if address :is "from" "spammer@remote-tr.test" { discard; }';
const PDF = 'header :mime :anychild :subtype "content-type" "pdf"';
const LOOP_FLAGS = 'foreverypart { if header :mime :subtype "content-type" "pdf" { addflag "pdf"; } }';

function parts(count: number): string {
  return 'From: spammer@remote-tr.test\r\nContent-Type: multipart/mixed; boundary=b\r\n\r\n' +
    '--b\r\n\r\nx\r\n'.repeat(count) + '--b--\r\n';
}
function nested(depth: number): string {
  let body = 'leaf';
  for (let i = depth - 1; i >= 0; i--) body = `Content-Type: multipart/mixed; boundary=b${i}\r\n\r\n--b${i}\r\n${body}\r\n--b${i}--\r\n`;
  return 'From: spammer@remote-tr.test\r\n' + body;
}
function exec(commands: string, eml = parts(1030)) {
  const { headers, size, body } = parseEml(eml);
  const s = load(REQUIRE + commands, { enabledExtensions: ALL_EXTENSIONS, maxExecSteps: 200_000, maxMatchInputLength: 16 * 1024 });
  const d = newRuntimeData(s, new DummyPolicy(), new EnvelopeStatic("spammer@remote-tr.test", "to@local.test"), new MessageStatic(size, headers, body));
  s.execute(d);
  // The fallback models Core's old run-wide guard and keeps this test commit
  // buildable before the per-outcome disclosure exists.
  const uncertain = (d as typeof d & { localDeliveryOnGuess?: boolean }).localDeliveryOnGuess ?? d.indeterminate;
  const keepsLocal = d.keep || d.implicitKeep || d.mailboxes.length > 0;
  return { d, uncertain, keepsLocal };
}

function definiteDrop(commands: string, eml?: string) {
  const { d, uncertain, keepsLocal } = exec(commands, eml);
  expect(d.indeterminate, "uncertainty remains disclosed for diagnostics").toBe(true);
  expect(keepsLocal).toBe(false);
  expect(uncertain, "only uncertainty that can change local delivery refuses a drop").toBe(false);
}

it.each([parts(1030), nested(101)])("a small open MIME tree cannot defeat a flag-independent discard", (eml) => {
  expect(eml.length).toBeLessThan(16 * 1024);
  definiteDrop(LOOP_FLAGS + DISCARD, eml);
});

it.each([parts(1000), nested(99)])("complete-tree controls remain definite", (eml) => {
  const r = exec(LOOP_FLAGS + DISCARD, eml);
  expect([r.d.indeterminate, r.keepsLocal, r.uncertain]).toEqual([false, false, false]);
});

it.each([
  LOOP_FLAGS,
  `if ${PDF} { addflag "pdf"; }`,
  'foreverypart { set "unused" "changed"; }',
  'foreverypart { if header :mime :subtype "content-type" "pdf" { addheader "X-Unrelated" "changed"; } }',
  LOOP_FLAGS + 'if hasflag "pdf" {}',
])("unrelated uncertain writes do not infect a later discard: %s", (before) => {
  definiteDrop(before + DISCARD);
});

it.each(['discard;', 'redirect "archive@remote.test";', 'reject "no";'])("a definite %s after flag uncertainty still cancels implicit keep", (action) => {
  definiteDrop(LOOP_FLAGS + action);
});

it.each(['discard;', 'redirect "archive@remote.test";', 'reject "no";'])("flag uncertainty after a definite %s does not undo its proof", (action) => {
  definiteDrop(action + LOOP_FLAGS);
});

describe("possible local delivery and control flow still protect mail", () => {
  it.each(['keep;', 'fileinto "Pdf";', 'fileinto :copy "Pdf";'])("unseen iterations that could %s prevent a drop", (action) => {
    const r = exec(`foreverypart { if header :mime :subtype "content-type" "pdf" { ${action} } }` + DISCARD);
    expect([r.d.indeterminate, r.keepsLocal, r.uncertain]).toEqual([true, false, true]);
  });

  it.each(['keep;', 'fileinto "Pdf";'])("an unknown anychild guard could %s", (action) => {
    const r = exec(`if ${PDF} { ${action} }` + DISCARD);
    expect([r.keepsLocal, r.uncertain]).toEqual([false, true]);
  });

  it("a discard in the else of an unknown guard is uncertain", () => {
    const r = exec(`if ${PDF} {} else { discard; }`);
    expect([r.keepsLocal, r.uncertain]).toEqual([false, true]);
  });

  it("an unseen stop could prevent the later discard", () => {
    const r = exec('foreverypart { if header :mime :subtype "content-type" "pdf" { stop; } }' + DISCARD);
    expect([r.keepsLocal, r.uncertain]).toEqual([false, true]);
  });

  it("a stop chosen by an unknown could skip a later keep", () => {
    const r = exec(`discard; if ${PDF} {} else { stop; } keep;`);
    expect([r.keepsLocal, r.uncertain]).toEqual([false, true]);
  });

  it("a possibly missed vacation could invalidate a reject", () => {
    const r = exec(`reject "no"; if ${PDF} { vacation "away"; }`);
    expect([r.keepsLocal, r.uncertain]).toEqual([false, true]);
  });

  it("a reject in an unknown-decided else has no definite cancellation", () => {
    const r = exec(`if ${PDF} {} else { reject "no"; }`);
    expect([r.keepsLocal, r.uncertain]).toEqual([false, true]);
  });
});

describe("later tests see the specific writes unseen iterations could make", () => {
  it.each([
    ['set "v" "unchanged"; foreverypart { if header :mime :subtype "content-type" "pdf" { set "v" "changed"; } }', 'string :is "${v}" "unchanged"'],
    [LOOP_FLAGS, 'not hasflag "pdf"'],
    ['foreverypart { if header :mime :subtype "content-type" "pdf" { deleteheader "from"; } }', 'address :is "from" "spammer@remote-tr.test"'],
  ])("a test reading uncertain state cannot authorize a discard", (before, condition) => {
    const r = exec(before + `if ${condition} { discard; }`);
    expect(r.d.indeterminate).toBe(true);
    expect(r.keepsLocal, "the dependent test itself must answer unknown").toBe(true);
  });

  it.each([
    ['foreverypart { set "v" "maybe"; } set "v" "known";', 'string :is "${v}" "known"'],
    [LOOP_FLAGS + 'setflag "known";', 'hasflag "known"'],
    ['foreverypart { if header :mime :subtype "content-type" "pdf" { addheader "X-Test" "maybe"; } } deleteheader "X-Test"; addheader "X-Test" "known";', 'header :is "X-Test" "known"'],
  ])("a definite overwrite restores an exact value", (before, condition) => {
    definiteDrop(before + `if ${condition} { discard; }`);
  });
});
