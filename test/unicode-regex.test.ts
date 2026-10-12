// #110: regex matching folds characters in the VM, never the source or raw
// pattern syntax. Use default Unicode simple case folding (UTS #18 RL1.5).
import { describe, expect, it } from "vitest";
import { compile, run } from "./harness.js";
const REQUIRE = 'require ["variables","fileinto","regex","body","comparator-i;unicode-casemap"];';
const quote = (s: string) => '"' + s.replaceAll('\\', '\\\\').replaceAll('"', '\\"') + '"';
const script = (pattern: string, source: string, action = 'fileinto "hit";') => REQUIRE + `if string :regex :comparator "i;unicode-casemap" ${quote(source)} ${quote(pattern)} { ${action} }`;
const hit = (pattern: string, source: string) => run(script(pattern, source)).fileinto.includes('hit');

it.each([
  ['CAFÉ','CAFÉ'], ['CAFÉ','café'], ['café','CAFÉ'], ['ÉTÉ','été'], ['Å','Å'],
  ['Σ','ς'], ['ς','Σ'], ['σ','Σ'], ['σ','ς'], ['K','K'], ['S','ſ'],
  ['ß','ẞ'], ['ẞ','ß'], ['µ','Μ'], ['ϐ','Β'], ['\u{10400}','\u{10428}'],
])('matches literal %s against %s', (pattern, source) => expect(hit('^' + pattern + '$', source)).toBe(true));
it.each([['ß','ss'],['é','e\u0301'],['ｓ','s'],['İ','i'],['ı','i']])('simple folding keeps %s distinct from %s', (pattern, source) => expect(hit('^' + pattern + '$', source)).toBe(false));
it('captures preserve case and supplementary characters from the source', () => {
  expect(run(script('^(CAFÉ)-(.+)$','café-\u{10400}MiXeD','fileinto "${1}|${2}";')).fileinto).toEqual(['café-\u{10400}MiXeD'.replace('-', '|')]);
  expect(run(script('^(café)$','CAFÉ','fileinto "${1}";')).fileinto).toEqual(['CAFÉ']);
});
it.each([
  ['[É]','é',true], ['[é]','É',true], ['[^É]','é',false], ['[^é]','É',false],
  ['[À-Ö]','é',true], ['[à-ö]','É',true], ['[Σ]','ς',true], ['[^ς]','Σ',false],
  ['[a-z]','K',true], ['[a-z]','ſ',true], ['[^a-z]','K',false], ['[\u{10400}-\u{10427}]','\u{10428}',true],
  ['\\w','K',true], ['[\\w]','K',true], ['\\W','K',false], ['[\\W]','K',false], ['[^\\W]','K',true],
  ['\\D','É',true], ['\\d','É',false], ['\\S','É',true], ['[\\S]','É',true],
])('class %s on %s gives %s', (pattern, source, expected) => expect(hit('^' + pattern + '$', source)).toBe(expected));
it('keeps word boundaries ASCII-based as in the existing engine', () => {
  expect(hit('\\bK\\b','K')).toBe(false);
  expect(hit('\\bK\\b','K')).toBe(true);
});
it('escaped punctuation and uppercase escape names retain their syntax', () => {
  expect(hit('^CAFÉ\\.\\D+$','café.É')).toBe(true);
  expect(hit('^CAFÉ\\.\\D+$','café.42')).toBe(false);
  expect(hit('^CAFÉ\\.\\D+$','café!É')).toBe(false);
});
it('dynamic keys get the same Unicode semantics and original captures', () => {
  const s = REQUIRE + 'set "p" "^(CAFÉ)$"; if string :regex :comparator "i;unicode-casemap" "café" "${p}" { fileinto "${1}"; }';
  expect(run(s).fileinto).toEqual(['café']);
});
it('i;octet and i;ascii-casemap keep their existing behavior', () => {
  for (const comparator of ['i;octet','i;ascii-casemap']) {
    expect(run(script('^É$','é').replace(':comparator "i;unicode-casemap"', `:comparator "${comparator}"`)).fileinto).toEqual([]);
  }
});
it('does not legalize an invalid quantifier-first pattern', () => expect(() => compile(script('*É','É'))).toThrow());
describe('bounds and prefixes', () => {
  const bodyRule = (pattern: string) => REQUIRE + `if body :regex :comparator "i;unicode-casemap" ${quote(pattern)} { fileinto "hit"; }`;
  it('a hit before the cut stays definite', () => expect(run(bodyRule('CAFÉ'), '\r\n\r\nCAFÉ rest', {options:{maxMatchInputLength:5}}).fileinto).toEqual(['hit']));
  it('an end assertion at the cut stays unknown', () => {
    const d = run(bodyRule('^CAFÉ$'), '\r\n\r\nCAFÉ rest', {options:{maxMatchInputLength:5}});
    expect([d.fileinto,d.indeterminate]).toEqual([[],true]);
  });
  it('a split UTF-8 character is never made into a false match', () => {
    const d = run(bodyRule('É'), '\r\n\r\nCAFÉ', {options:{maxMatchInputLength:4}});
    expect([d.fileinto,d.indeterminate]).toEqual([[],true]);
  });
  it('exhausted matching work still answers unknown', () => {
    const d = run(bodyRule('(É|é)+never'), '\r\n\r\n'+'é'.repeat(10_000), {options:{maxExecSteps:500}});
    expect([d.fileinto,d.indeterminate]).toEqual([[],true]);
  });
});
