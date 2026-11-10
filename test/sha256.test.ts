// The library's own SHA-256, which keys vacation responses: execute() is
// synchronous and the library takes nothing from the host, so WebCrypto's
// asynchronous digest is out of reach.

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../src/interp/sha256.js";

const enc = new TextEncoder();
const node = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

describe("sha256Hex", () => {
  it("FIPS 180-4 vectors", () => {
    expect(sha256Hex(new Uint8Array(0))).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex(enc.encode("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sha256Hex(enc.encode("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"))).toBe(
      "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
    );
    expect(sha256Hex(new Uint8Array(1_000_000).fill(0x61))).toBe("cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0");
  });

  it("agrees with node:crypto across every padding boundary", () => {
    // Lengths 55/56 and 63/64 decide whether the length field takes a block
    // of its own; every byte value appears.
    for (let n = 0; n <= 200; n++) {
      const b = Uint8Array.from({ length: n }, (_, i) => (i * 131 + n) & 0xff);
      expect(sha256Hex(b), `length ${n}`).toBe(node(b));
    }
  });
});
