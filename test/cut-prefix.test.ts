// A cut input must reduce to a prefix of what the whole input reduces to.
//
// A body cut by the host's read window, or a value cut by the engine's
// match-input cap, is evaluated as a PREFIX of the real content: a definite
// answer must hold whatever follows the cut (see truncation.test.ts). That
// needs every step between the bytes and the compared text to turn a prefix of
// its input into a prefix of its output, and four did not:
// - the engine's default 256 KiB match-input cut (a host that sets no
//   maxMatchInputLength) was not marked as a cut at all;
// - charset decoding turned a multi-byte character split by the cut into
//   U+FFFD, and so did the regex engine's own byte cut;
// - quoted-printable decoding kept an escape split by the cut ("=C3=A") as
//   literal text;
// - the HTML reduction read whatever was open at the cut (a "<", a tag, a
//   character reference, a raw-text element) as it reads the real end of
//   the input.
// Each turned into a definite answer about bytes nobody read: a `not`-guarded
// rule fired.

import { describe, expect, it } from "vitest";
import { DummyPolicy, EnvelopeStatic, load, MessageStatic, newRuntimeData } from "../src/index.js";
import { htmlToText } from "../src/interp/htmltext.js";
import { ALL_EXTENSIONS, R, run } from "./harness.js";

/** Run against a body given as BYTES, so a cut can split a character. */
function runBytes(script: string, headers: Record<string, string>, body: number[] | Uint8Array, truncated: boolean) {
  const s = load(script, { enabledExtensions: ALL_EXTENSIONS });
  const h = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), [v]]));
  const d = newRuntimeData(s, new DummyPolicy(), new EnvelopeStatic(), new MessageStatic(0, h, Uint8Array.from(body), truncated));
  s.execute(d);
  return { fileinto: d.mailboxes, indeterminate: d.indeterminate };
}

const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
const notFiled = { fileinto: [], indeterminate: true };

describe("the engine's default match-input cut is a cut", () => {
  const body = `${"x".repeat(300 * 1024)}needle\r\n`;
  const eml = `From: a@x\r\nTo: b@y\r\nSubject: hi\r\n\r\n${body}`;

  it("a not-guarded :regex past 256 KiB is not taken", () => {
    expect(run('require ["body","fileinto","regex"]; if not body :raw :regex "needle" { fileinto "NoNeedle"; }', eml)).toEqual(
      R({ implicitKeep: true, indeterminate: true }),
    );
  });

  it("a not-guarded :matches past 256 KiB is not taken", () => {
    expect(run('require ["body","fileinto"]; if not body :raw :matches "*needle*" { fileinto "NoNeedle"; }', eml)).toEqual(
      R({ implicitKeep: true, indeterminate: true }),
    );
  });

  it("a match inside the first 256 KiB is still definite", () => {
    expect(run('require ["body","fileinto","regex"]; if body :raw :regex "^x" { fileinto "X"; }', eml)).toEqual(
      R({ fileinto: ["X"] }),
    );
  });
});

describe("a multi-byte character split by the cut", () => {
  const isCafe = 'require ["body","fileinto"]; if not body :content "text/plain" :is "café" { fileinto "NotCafe"; }';

  it("UTF-8: the split character is not read as U+FFFD (the issue's case)", () => {
    // "café" cut between the two bytes of "é".
    expect(runBytes(isCafe, { "Content-Type": "text/plain; charset=utf-8" }, [...ascii("caf"), 0xc3], true)).toEqual(notFiled);
  });

  it("Shift_JIS: the same for a two-byte character", () => {
    // "日本" is 93 FA 96 7B; cut after 96.
    const script = 'require ["body","fileinto"]; if not body :content "text/plain" :is "日本" { fileinto "Not"; }';
    expect(runBytes(script, { "Content-Type": "text/plain; charset=shift_jis" }, [0x93, 0xfa, 0x96], true)).toEqual(notFiled);
  });

  it("the whole character, uncut, still answers definitely", () => {
    expect(runBytes(isCafe, { "Content-Type": "text/plain; charset=utf-8" }, [...ascii("caf"), 0xc3, 0xa9], false)).toEqual({
      fileinto: [],
      indeterminate: false,
    });
  });

  it("the regex engine's own byte cut does not read the split character as U+FFFD", () => {
    // 4 bytes of "café" end inside "é": "caf[^é]" matched the U+FFFD.
    const script = 'require ["regex","fileinto"]; if header :regex "subject" "caf[^é]" { fileinto "Hit"; }';
    expect(run(script, "Subject: café\r\n\r\n", { options: { maxMatchInputLength: 4 } })).toEqual(
      R({ implicitKeep: true, indeterminate: true }),
    );
  });
});

describe("a quoted-printable escape split by the cut", () => {
  const qp = { "Content-Type": "text/plain; charset=utf-8", "Content-Transfer-Encoding": "quoted-printable" };
  const isCafe = 'require ["body","fileinto"]; if not body :content "text/plain" :is "café" { fileinto "NotCafe"; }';

  for (const cut of ["caf=C3=A", "caf=C3=", "caf=C3", "caf=C", "caf=", "ca=\r"]) {
    it(`cut after ${JSON.stringify(cut)}`, () => {
      expect(runBytes(isCafe, qp, ascii(cut), true)).toEqual(notFiled);
    });
  }

  it("an escape the cut did not split still decodes", () => {
    expect(runBytes(isCafe, qp, ascii("caf=C3=A9"), true)).toEqual(notFiled);
    expect(runBytes(isCafe, qp, ascii("caf=C3=A9"), false)).toEqual({ fileinto: [], indeterminate: false });
  });

  it("an uncut body keeps a bare '=' at its end as text", () => {
    const script = 'require ["body","fileinto"]; if body :content "text/plain" :is "caf=" { fileinto "Lit"; }';
    expect(runBytes(script, qp, ascii("caf="), false)).toEqual({ fileinto: ["Lit"], indeterminate: false });
  });
});

describe("the HTML reduction of a cut part", () => {
  const SAMPLES = [
    "<p>caf&eacute; &amp; more</p><p>next</p>",
    "a &#233;t&#xE9; b &#128512; c",
    "x <b>bold</b> y &notit; z &copy2026",
    "<!-- c --> after <!-- d -- > e --> f <!--> g <!---> h",
    "<script>if (a<b) x</script> shown",
    "<textarea>a &amp; <b> b</textarea> after",
    "<title>t</title><xmp>a&amp;b</xmp> c",
    "<svg><text>in svg</text></svg> out &amp; done <b>x</b>",
    "<math><![CDATA[ cd &amp; ]]></math> tail <i>t</i>",
    "<select><option>o</option></select> s <xmp>k</xmp> m",
    "<script><!-- <script> x </script> y </script> z",
    "1 < 2 and 3 > 2 <3 love <",
    "<a href='x>y'>link</a> text <a title=\"q>\" b=c>d</a>",
    "<plaintext>p &amp; <b>",
    "&am &amp &ampx &#12 &#x1F600; end",
    "<noscript><p>ns</p></noscript> after",
    "<p>a</p\n> <br/> <img src=x alt=\"<b>\"> b <!DOCTYPE html> c <?xml x?> d </ x> e",
    "<svg>a < b <c d> &amp e</svg> f",
    // A bounded closer at the cut may continue: "</textareas>" closes nothing.
    "<svg><textarea>a&amp;b</textareas>c</textarea> d",
    "<math><xmp>p</xmpx>q</xmp> r",
    // "&" plus 31 characters: a 32nd could still be the ";" that decodes it.
    "x &CounterClockwiseContourIntegral; y",
  ];

  it("every cut of every sample reduces to a prefix of the whole", () => {
    const failures: string[] = [];
    for (const s of SAMPLES) {
      const whole = htmlToText(s);
      for (let k = 0; k <= s.length; k++) {
        const part = htmlToText(s.slice(0, k), true);
        if (!whole.startsWith(part)) failures.push(`${JSON.stringify(s.slice(0, k))} → ${JSON.stringify(part)}, whole ${JSON.stringify(whole)}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it("text before the cut is kept: only what was open at it goes", () => {
    expect(htmlToText("<p>hello</p><p>wor", true)).toBe("hello wor");
    expect(htmlToText("a &amp; b &am", true)).toBe("a & b");
    expect(htmlToText("<p>x</p><scr", true)).toBe("x");
    expect(htmlToText("abc<scr", true)).toBe("abc");
    expect(htmlToText("<p>x</p><", true)).toBe("x");
  });

  it("an uncut part reads the end of the input as the end", () => {
    expect(htmlToText("<p>x</p><")).toBe("x <");
    expect(htmlToText("a &am")).toBe("a &am");
  });

  it("a not-guarded rule over a cut HTML part is not taken", () => {
    // The part's last byte is a "<": in the whole message it opens a tag.
    const script = 'require ["body","fileinto"]; if not body :text :is "x" { fileinto "NotX"; }';
    expect(runBytes(script, { "Content-Type": "text/html; charset=utf-8" }, ascii("<p>x</p><"), true)).toEqual(notFiled);
  });
});

describe("i;unicode-casemap over a cut input", () => {
  it("does not decide definite false when the prefix fold context differs from the whole", () => {
    // "ΑΣ" at end-of-prefix would fold to "ας" with context-sensitive toLowerCase(),
    // while the whole "ΑΣΑ" folds to "ασα". "ασα" does not start with "ας",
    // so a context-sensitive fold falsely concludes the key cannot match.
    const body = new TextEncoder().encode("ΑΣ");
    const script =
      'require ["body","fileinto","comparator-i;unicode-casemap"]; if not body :comparator "i;unicode-casemap" :is "ΑΣΑ" { fileinto "X"; }';
    expect(runBytes(script, { "content-type": "text/plain; charset=utf-8" }, body, true)).toEqual(notFiled);
  });

  it("a final sigma before a space folds as one mid-string does", () => {
    const body = new TextEncoder().encode("ΑΣ");
    const script =
      'require ["body","fileinto","comparator-i;unicode-casemap"]; if not body :comparator "i;unicode-casemap" :is "ΑΣ Α" { fileinto "X"; }';
    expect(runBytes(script, { "content-type": "text/plain; charset=utf-8" }, body, true)).toEqual(notFiled);
  });
});

