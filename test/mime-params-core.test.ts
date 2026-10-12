// #82: :param must read the same parameter map as Core's MIME walker.
// Expected values were checked with Core's parseHeaderWithParams, followed
// by goUtf8ToString as its bodystructure output does.

import { describe, expect, it } from "vitest";
import { R, run } from "./harness.js";

const REQ = 'require ["mime", "fileinto", "foreverypart", "editheader", "relational", "comparator-i;ascii-numeric"];';

function script(field: string, parameter: string, test: string, scope = ""): string {
  return `${REQ} if header :mime ${scope} :param "${parameter}" ${test} "${field}" "evil.exe" { fileinto "Match"; }`;
}

const malformed = [
  ['missing equals', 'name="evil.exe"; bad'],
  ['empty parameter name', 'name="evil.exe"; =value'],
  ['empty unquoted value', 'name="evil.exe"; bad='],
  ['unterminated quoted value', 'name="evil.exe"; bad="unterminated'],
  ['text after quoted value', 'name="evil.exe" junk'],
  ['invalid token', 'name=evil.exe; bad=has space'],
  ['conflicting duplicate', 'name="evil.exe"; name="safe.pdf"'],
  ['conflicting continuation', 'name*0="evil"; name*1=".exe"; name*1=".pdf"'],
  ['malformed prefix', 'bad; name="evil.exe"'],
] as const;

describe(":param follows Core's malformed-list handling (#82)", () => {
  for (const [label, params] of malformed) {
    for (const [field, base] of [["Content-Type", "application/octet-stream"], ["Content-Disposition", "attachment"]]) {
      it(`${field}: ${label}`, () => {
        const message = `${field}: ${base}; ${params}\r\n\r\nbody`;
        expect(run(script(field!, "name", ":is"), message)).toEqual(R({ implicitKeep: true }));
        // No other parameter from the invalid list is retained either.
        expect(run(`${REQ} if header :mime :param ["name", "bad"] :count "eq" :comparator "i;ascii-numeric" "${field}" "0" { fileinto "Empty"; }`, message))
          .toEqual(R({ fileinto: ["Empty"] }));
      });
    }
  }

  it("rejects all parameters when the media type itself does not parse", () => {
    expect(run(script("content-type", "name", ":is"), 'Content-Type: bad type; name="evil.exe"\r\n\r\nbody'))
      .toEqual(R({ implicitKeep: true }));
  });

  it("uses the same parser inside multipart loops and :anychild", () => {
    const message = 'Content-Type: multipart/mixed; boundary=b\r\n\r\n--b\r\nContent-Disposition: attachment; filename="evil.exe"; bad\r\n\r\nbody\r\n--b--\r\n';
    expect(run(script("content-disposition", "filename", ":is", ":anychild"), message)).toEqual(R({ implicitKeep: true }));
    expect(run(`${REQ} foreverypart { if header :mime :param "filename" :is "content-disposition" "evil.exe" { fileinto "Match"; } }`, message))
      .toEqual(R({ implicitKeep: true }));
  });

  it("reparses a value supplied by editheader without retaining the old parameter map", () => {
    const message = 'Content-Disposition: attachment; filename="evil.exe"\r\n\r\nbody';
    const s = `${REQ}
      if header :mime :param "filename" "content-disposition" "evil.exe" { fileinto "Before"; }
      deleteheader "Content-Disposition";
      addheader "Content-Disposition" "attachment; filename=evil.exe; bad";
      if header :mime :param "filename" "content-disposition" "evil.exe" { fileinto "After"; }`;
    expect(run(s, message)).toEqual(R({ fileinto: ["Before"] }));
  });
});

describe(":param retains Core's valid and decoded parameter values", () => {
  it.each(["__proto__", "constructor", "toString"])("preserves the ordinary parameter name %s", (name) => {
    const message = `Content-Disposition: attachment; ${name}="evil.exe"\r\n\r\nbody`;
    expect(run(script("content-disposition", name, ":is"), message)).toEqual(R({ fileinto: ["Match"] }));
  });

  it.each([
    ['trailing semicolon', 'attachment; filename="evil.exe";', 'evil.exe'],
    ['identical duplicate', 'attachment; filename="evil.exe"; filename="evil.exe"', 'evil.exe'],
    ['quoted semicolon', 'attachment; filename="evil;name.exe"', 'evil;name.exe'],
    ['literal Unicode', 'attachment; filename="café.exe"', 'café.exe'],
    ['extended Unicode', "attachment; filename*=utf-8''caf%C3%A9.exe", 'café.exe'],
    ['split Unicode continuation', "attachment; filename*0*=utf-8''%E2%82; filename*1*=%AC.exe", '€.exe'],
    ['encoded word', 'attachment; filename="=?utf-8?Q?caf=C3=A9.exe?="', 'café.exe'],
    ['unknown encoded-word charset stays raw', 'attachment; filename="=?bogus?Q?evil.exe?="', '=?bogus?Q?evil.exe?='],
  ])("%s", (_label, value, expected) => {
    const s = `${REQ} if header :mime :param "filename" :is "content-disposition" "${expected}" { fileinto "Match"; }`;
    expect(run(s, `Content-Disposition: ${value}\r\n\r\nbody`)).toEqual(R({ fileinto: ["Match"] }));
  });
});
