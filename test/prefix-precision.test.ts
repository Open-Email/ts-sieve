// #61: preserve proven prefixes and lower bounds, without trusting the hidden
// continuation or turning one unknown disjunct into an unknown whole test.
import { describe, expect, it } from "vitest";
import { DummyPolicy, EnvelopeStatic, load, MessageStatic, newRuntimeData, type Options } from "../src/index.js";
import { ALL_EXTENSIONS, parseEml } from "./harness.js";
const REQUIRE = 'require ["variables","fileinto","imap4flags","relational","comparator-i;ascii-numeric","editheader","mime"];';
const SET = 'if header :matches "x-long" "*" { set "s" "${1}"; }';
const LONG = 'urgent $label1 ' + 'a'.repeat(400);
function exec(commands: string, value = LONG, options: Options = {}) {
  const s = load(REQUIRE + SET + commands, { enabledExtensions: ALL_EXTENSIONS, maxMatchInputLength: 256, ...options });
  const { headers, size, body } = parseEml(`From: sender@example.test\r\nSubject: x\r\nX-Long: ${value}\r\n\r\nbody`);
  const d = newRuntimeData(s, new DummyPolicy(), new EnvelopeStatic('sender@example.test','to@local.test'), new MessageStatic(size, headers, body));
  s.execute(d); return d;
}
function verdict(test: string, before = '', value?: string, options?: Options) {
  const d = exec(before + `if ${test} { fileinto "yes"; } elsif not ${test} { fileinto "no"; }`, value, options);
  return { verdict: d.mailboxes[0] ?? 'unknown', d };
}

it.each(['header :contains ["${s}", "subject"] "x"', 'header :mime :contains ["${s}", "subject"] "x"'])("a known member proves %s", test => {
  const { verdict: v, d } = verdict(test); expect(v).toBe('yes'); expect(d.indeterminate).toBe(false);
});
it("a marked header name alone cannot use the field named by the visible prefix", () => {
  expect(verdict('header :contains "${s}" "x"', '', 'subject-extra', {maxMatchInputLength:7}).verdict).toBe('unknown');
});
it("an uncertain first header match does not lend certainty to a later capture", () => {
  const d = exec('if header :matches ["${s}", "from"] "*" { redirect "${1}"; }');
  expect(d.redirectAddr).toEqual([]); expect(d.redirectsDropped).toBe(1);
});
it("a fresh capture after an unknown header test restores its certainty", () => {
  const d = exec('if header :matches "${s}" "*" {} if header :matches "from" "*" {} redirect "${1}";');
  expect(d.redirectAddr).toEqual(['sender@example.test']);
});

it("hasflag proves a complete token before the cut", () => expect(verdict('hasflag "s" "$label1"').verdict).toBe('yes'));
it("hasflag retains a definite member beside a wholly uncertain variable", () => {
  expect(verdict('hasflag ["u", "known"] "$label1"', 'set :length "u" "${s}"; set "known" "$label1";').verdict).toBe('yes');
});
it("hasflag cannot trust the final partial token or the absence of a token", () => {
  expect(verdict('hasflag "s" "' + 'a'.repeat(242) + '"').verdict).toBe('unknown');
  expect(verdict('hasflag "s" "$missing"').verdict).toBe('unknown');
});
it("hasflag count treats known tokens as a lower bound", () => {
  expect(verdict('hasflag :count "gt" :comparator "i;ascii-numeric" "s" "1"').verdict).toBe('yes');
  expect(verdict('hasflag :count "eq" :comparator "i;ascii-numeric" "s" "2"').verdict).toBe('unknown');
});

const TAIL = 'set "line" "${s} (via list)";';
it.each(['', 'set "line" "${line}";', 'set :lower "line" "${line}";', 'set :upper "line" "${line}";', 'set :quotewildcard "line" "${line}";'])("a proven head survives text after it and modifiers: %s", extra => {
  expect(verdict('string :contains "${line}" "urgent"', TAIL + extra).verdict).toBe('yes');
});
it("the appended suffix is not part of the proven head", () => {
  expect(verdict('string :contains "${line}" "(via list)"', TAIL).verdict).toBe('unknown');
  expect(verdict('string :matches "${line}" "*(via list)"', TAIL).verdict).toBe('unknown');
});
it("a leading literal is still proven before a wholly uncertain value", () => {
  expect(verdict('string :contains "${line}" "known"', 'set :length "n" "${s}"; set "line" "known:${n}";').verdict).toBe('yes');
});
it("a partial-head value cannot become an exact redirect target", () => {
  const d = exec(TAIL + 'redirect "${line}";'); expect(d.redirectAddr).toEqual([]); expect(d.redirectsDropped).toBe(1);
});
it("an added header retains only the proven portion of a value", () => {
  expect(verdict('header :contains "X-Proof" "urgent"', TAIL + 'addheader "X-Proof" "${line}";').verdict).toBe('yes');
  expect(verdict('header :contains "X-Proof" "(via list)"', TAIL + 'addheader "X-Proof" "${line}";').verdict).toBe('unknown');
});
it("unfolding an added header preserves the actual proven head", () => {
  const value='urgent\t' + 'a'.repeat(400);
  expect(verdict('header :contains "X-Proof" "urgent"', TAIL + 'addheader "X-Proof" "${line}";', value).verdict).toBe('yes');
});

describe('length of a prefix is a numeric lower bound', () => {
  it.each([
    ['gt', '200', 'yes'], ['ge', '256', 'yes'], ['lt', '200', 'no'], ['le', '200', 'no'],
    ['eq', '200', 'no'], ['ne', '200', 'yes'], ['gt', '256', 'unknown'], ['eq', '256', 'unknown'],
    ['lt', '999', 'unknown'], ['ne', '999', 'unknown'],
  ])('%s %s gives %s', (op, key, expected) => {
    expect(verdict(`string :value "${op}" :comparator "i;ascii-numeric" "\${n}" "${key}"`, 'set :length "n" "${s}";').verdict).toBe(expected);
  });
  it('preserves the bound through an unmodified variable copy', () => {
    expect(verdict('string :value "gt" :comparator "i;ascii-numeric" "${copy}" "200"', 'set :length "n" "${s}"; set "copy" "${n}";').verdict).toBe('yes');
  });
  it('does not apply a numeric bound to a lexical comparator or an altered number', () => {
    expect(verdict('string :value "gt" "${n}" "200"', 'set :length "n" "${s}";').verdict).toBe('unknown');
    expect(verdict('string :value "gt" :comparator "i;ascii-numeric" "${n}" "200"', 'set :length "n" "${s}"; set "n" "0${n}";').verdict).toBe('unknown');
  });
  it('counts Unicode code points, rather than UTF-8 bytes or UTF-16 units', () => {
    expect(verdict('string :value "ge" :comparator "i;ascii-numeric" "${n}" "64"', 'set :length "n" "${s}";', '😀'.repeat(100)).verdict).toBe('yes');
    expect(verdict('string :value "ge" :comparator "i;ascii-numeric" "${n}" "100"', 'set :length "n" "${s}";', '😀'.repeat(100)).verdict).toBe('unknown');
  });
  it('uses only the proven head when measuring a value with appended text', () => {
    expect(verdict('string :value "gt" :comparator "i;ascii-numeric" "${n}" "256"', TAIL + 'set :length "n" "${line}";').verdict).toBe('unknown');
  });
});

it.each(['address :is ["${s}", "from"] "sender@example.test"', 'address :mime :is ["${s}", "from"] "sender@example.test"'])("a known address-header member proves %s", test => {
  expect(verdict(test).verdict).toBe('yes');
});
it("a header count can be proved without knowing every field name", () => {
  expect(verdict('header :count "ge" :comparator "i;ascii-numeric" ["${s}", "subject"] "1"').verdict).toBe('yes');
});
it("prefix and length metadata survive cloning without being mutated by overwrites", () => {
  const parent = exec(TAIL + 'set :length "n" "${s}";');
  const s = load(REQUIRE + 'set "copy" "${line}"; set :upper "line" "${line}"; if string :contains "${copy}" "urgent" { fileinto "head"; } if string :value "gt" :comparator "i;ascii-numeric" "${n}" "200" { fileinto "length"; }', { enabledExtensions: ALL_EXTENSIONS });
  const child = parent.clone(s); s.execute(child);
  expect(child.mailboxes).toEqual(['head', 'length']);
  expect(parent.variables.get('line')!.startsWith('urgent')).toBe(true);
  expect(child.variables.get('line')!.startsWith('URGENT')).toBe(true);
});
it("every definite prefix verdict agrees with concrete continuations", () => {
  const heads = ['urgent ' + 'a'.repeat(57), '$label1 ' + 'a'.repeat(56), 'A'.repeat(62) + 'Σ'];
  const transforms = [
    'set "line" "${s} (via list)";',
    'set "line" "known:${s}";',
    'set :lower "line" "${s} (via list)";',
    'set :upper "line" "${s} (via list)";',
    'set :quotewildcard "line" "${s} (via list)";',
    'set :length "line" "${s}";',
    'set "x" "${s} (via list)"; set :length "line" "${x}";',
  ];
  const tests = [
    'string :contains "${line}" "urgent"', 'string :contains "${line}" "known"',
    'string :contains :comparator "i;octet" "${line}" "ς"',
    'string :contains "${line}" "(via list)"', 'string :matches "${line}" "urgent*"',
    'string :value "gt" :comparator "i;ascii-numeric" "${line}" "50"',
    'string :value "lt" :comparator "i;ascii-numeric" "${line}" "50"',
  ];
  let proved = 0;
  for (const head of heads) for (const before of transforms) for (const test of tests) {
    const cut = verdict(test, before, head + 'hidden continuation', { maxMatchInputLength: 64 }).verdict;
    if (cut === 'unknown') continue;
    proved++;
    for (const tail of ['', 'rest', 'α', ' (via list)']) {
      const whole = verdict(test, before, head + tail, { maxMatchInputLength: 16_384 }).verdict;
      expect(whole, JSON.stringify({ head, before, test, tail })).toBe(cut);
    }
  }
  expect(proved).toBeGreaterThan(20);
});
