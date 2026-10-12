// #65: an uncertain recoverable effect must not make an independent local
// drop uncertain. A possibly missed local store must still prevent the drop.
import { describe, expect, it } from "vitest";
import { DummyPolicy, EnvelopeStatic, load, MessageStatic, newRuntimeData, redirectsOnGuess, type Options } from "../src/index.js";
import { ALL_EXTENSIONS, parseEml } from "./harness.js";

const REQUIRE = 'require ["foreverypart", "mime", "imap4flags", "fileinto", "variables", "editheader", "reject", "vacation", "copy", "relational", "comparator-i;ascii-numeric"];';
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
function exec(commands: string, eml = parts(1030), truncated = false, options: Options = {}) {
  const { headers, size, body } = parseEml(eml);
  const s = load(REQUIRE + commands, { enabledExtensions: ALL_EXTENSIONS, maxExecSteps: 200_000, maxMatchInputLength: 16 * 1024, ...options });
  const d = newRuntimeData(s, new DummyPolicy(), new EnvelopeStatic("spammer@remote-tr.test", "to@local.test"), new MessageStatic(size, headers, body, truncated));
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


it("a drop or forward proved over an open tree survives concrete completions", () => {
  const prefix = parts(1).replace("--b--\r\n", "");
  const completions = ["text/plain", "application/pdf"].map((type) => prefix + `--b\r\nContent-Type: ${type}\r\n\r\ntail\r\n--b--\r\n`);
  const actions = [
    'addflag "pdf";', 'removeflag "known";', 'setflag "pdf";',
    'set "v" "changed";', 'addflag "v" "changed";',
    'deleteheader "from";', 'addheader "X-Test" "yes";',
    'keep;', 'fileinto "Pdf";', 'redirect "archive@remote.test";',
    'discard;', 'stop;', 'break;', 'reject "no";', 'vacation "away";',
  ];
  const later = [
    DISCARD, 'redirect "archive@remote.test";', 'reject "no";',
    'if not hasflag "pdf" { discard; }',
    'if hasflag "pdf" { keep; } discard;',
    'if string :is "${v}" "known" { discard; }',
    'if string :is "${v}" "changed" { keep; } discard;',
    'if exists "x-test" { keep; } discard;',
    'if not exists "x-test" { discard; }',
    'if header :count "gt" "from" "0" { discard; }',
    'if address :is "from" "spammer@remote-tr.test" { redirect "archive@remote.test"; }',
    'if hasflag "pdf" {} else { stop; } keep;',
    'set "copy" "${v}"; if string :is "${copy}" "known" { discard; }',
    'deleteheader "X-Test"; addheader "X-Test" "yes"; if exists "x-test" { discard; }',
  ];
  let provedDrops = 0, provedForwards = 0;
  for (const action of actions) for (const tail of later) for (const initial of ["", "discard;", 'reject "no";']) {
    const script = 'set "v" "known"; setflag "known";' + initial +
      `foreverypart { if header :mime :subtype "content-type" "pdf" { ${action} } }` + tail;
    const cut = exec(script, prefix, true);
    const guessed = redirectsOnGuess(cut.d);
    const definiteForwards = cut.d.redirectAddr.filter((addr) => !guessed.includes(addr));
    const provedDrop = !cut.keepsLocal && !cut.uncertain;
    if (provedDrop) provedDrops++;
    provedForwards += definiteForwards.length;
    for (const whole of completions) {
      const result = exec(script, whole);
      if (provedDrop) expect(result.keepsLocal, script + "\n" + whole).toBe(false);
      for (const addr of definiteForwards) expect(result.d.redirectAddr, script + "\n" + whole).toContain(addr);
    }
  }
  expect(provedDrops, "the oracle must exercise actual drop proofs").toBeGreaterThan(30);
  expect(provedForwards, "the oracle must exercise actual forward proofs").toBeGreaterThan(10);
});

it("an uncertain delete cannot leave trusted captures for a later redirect", () => {
  const r = exec('if header :matches "from" "*" {} deleteheader :matches "subject" "*zzz"; redirect "${1}";',
    `From: archive@remote.test\r\nSubject: ${"x".repeat(20_000)}\r\n\r\nbody`);
  expect(r.d.indeterminate).toBe(true);
  expect(r.d.redirectAddr).toEqual([]);
  expect(r.d.redirectsDropped).toBe(1);
});

it("a budget-interrupted delete cannot restore trusted captures for a later redirect", () => {
  const subjects = Array.from({ length: 3 }, () => `Subject: ${"x".repeat(16_000)}\r\n`).join("");
  const r = exec('if header :matches "from" "*" {} deleteheader :matches "subject" "*casino*"; redirect "${1}";',
    `From: archive@remote.test\r\n${subjects}\r\nbody`);
  expect(r.d.budgetExhausted).toBe(true);
  expect(r.d.redirectAddr).toEqual([]);
  expect(r.d.redirectsDropped).toBe(1);
});

it("a definite field reset restores certainty after a dynamic unseen field write", () => {
  definiteDrop('set "name" "X-Test"; foreverypart { if header :mime :subtype "content-type" "pdf" { addheader "${name}" "maybe"; } } deleteheader "From"; addheader "From" "spammer@remote-tr.test";' + DISCARD);
});

it("a guessed else cannot restore certainty by writing a literal", () => {
  const r = exec(`set "v" "before"; if ${PDF} { set "v" "pdf"; } else { set "v" "other"; } if string :is "${'${v}'}" "other" { discard; }`);
  expect([r.d.indeterminate, r.keepsLocal]).toEqual([true, true]);
});

it("cloned header uncertainty can be cleared without changing the parent", () => {
  const parent = exec('foreverypart { if header :mime :subtype "content-type" "pdf" { addheader "X-Test" "maybe"; } }').d;
  const s = load(REQUIRE + 'deleteheader "X-Test"; addheader "X-Test" "known"; if header :is "X-Test" "known" { discard; }', { enabledExtensions: ALL_EXTENSIONS });
  const child = parent.clone(s);
  s.execute(child);
  expect([child.implicitKeep, child.localDeliveryOnGuess]).toEqual([false, false]);
  expect(parent.uncertainHeaders.has("x-test")).toBe(true);
  expect(child.uncertainHeaders.has("x-test")).toBe(false);
});

it("a cloned reject proof still accounts for a later uncertain conflict", () => {
  const parent = exec('reject "No.";', parts(1)).d;
  expect(parent.localDeliveryOnGuess).toBe(false);
  const s = load(REQUIRE + `if ${PDF} { vacation "away"; }`, { enabledExtensions: ALL_EXTENSIONS });
  const child = parent.clone(s);
  const { size, headers, body } = parseEml(parts(1030));
  child.msg = new MessageStatic(size, headers, body);
  s.execute(child);
  expect(child.localDeliveryOnGuess).toBe(true);
  expect(parent.localDeliveryOnGuess).toBe(false);
});

it("bounds uncertainty retained for distinct header edits dropped after the ledger fills", () => {
  const fill = 'addheader "X-Fill" "x";'.repeat(1024);
  const overflow = Array.from({ length: 2048 }, (_, i) => `addheader "X-Dropped-${i}" "x";`).join("");
  const { d } = exec(fill + overflow + 'discard;', parts(1), false, { maxTokens: 20_000 });
  expect(d.headerEditsDropped).toBe(2048);
  expect(d.uncertainHeaders.size).toBeLessThanOrEqual(1024);
  expect(d.allHeadersUncertain).toBe(true);
  expect(d.localDeliveryOnGuess).toBe(false);
});
