// encoded-character (RFC 5228 §2.4.2.4). Scripts use single-quoted JS strings so
// the literal ${hex:..}/${unicode:..} is not JS-interpolated.

import { describe, expect, it } from "vitest";
import { eml, R, run } from "./harness.js";

describe("encoded-character", () => {
  it("${hex:..} decodes at load time (0x49 0x20 → 'I ')", () => {
    expect(run('require "encoded-character"; if header :contains "Subject" "${hex:49 20}" { keep; }', eml)).toEqual(
      R({ keep: true, implicitKeep: true }),
    );
  });

  it("${unicode:..} decodes (0x70 → 'p')", () => {
    expect(run('require "encoded-character"; if header :contains "Subject" "${unicode:70}" { keep; }', eml)).toEqual(
      R({ keep: true, implicitKeep: true }),
    );
  });

  it("left literal without the require", () => {
    expect(run('if header :contains "Subject" "${hex:49}" { keep; }', eml)).toEqual(R({ implicitKeep: true }));
  });

  it("out-of-range unicode keypoint is a load error", () => {
    expect(() => run('require "encoded-character"; if header :is "Subject" "${unicode:D800}" { keep; }', eml)).toThrow();
  });
});
