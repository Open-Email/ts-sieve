// Shared test harness for the Sieve conformance corpus.
//
// Enables the FULL extension set, so any not-yet-implemented extension fails RED
// at its `require` (rejected by the library's supportedRequires) or at its
// command/test loader — turning green as each extension is implemented.

import { DummyPolicy, EnvelopeStatic, load, MessageStatic, newRuntimeData, type Options } from "../src/index.js";

/** The full extension list the conformance tests enable. */
export const ALL_EXTENSIONS = [
  "fileinto",
  "envelope",
  "encoded-character",
  "comparator-i;octet",
  "comparator-i;ascii-casemap",
  "comparator-i;ascii-numeric",
  "comparator-i;unicode-casemap",
  "imap4flags",
  "variables",
  "relational",
  "vacation",
  "copy",
  "regex",
  "date",
  "index",
  "editheader",
  "mailbox",
  "subaddress",
  "body",
];

export interface Result {
  redirect: string[];
  fileinto: string[];
  keep: boolean;
  implicitKeep: boolean;
  flags: string[];
}

/** Build an expected Result, defaulting empties (an all-empty Result). */
export const R = (o: Partial<Result>): Result => ({
  redirect: o.redirect ?? [],
  fileinto: o.fileinto ?? [],
  keep: o.keep ?? false,
  implicitKeep: o.implicitKeep ?? false,
  flags: o.flags ?? [],
});

/** Parse an RFC 822 message into a case-insensitive header map + byte size + body. */
export function parseEml(eml: string): { headers: Map<string, string[]>; size: number; body: Uint8Array | null } {
  const size = new TextEncoder().encode(eml).length;
  const sep = eml.match(/\r?\n\r?\n/);
  const headerBlock = sep ? eml.slice(0, sep.index!) : eml;
  const body = sep ? new TextEncoder().encode(eml.slice(sep.index! + sep[0].length)) : null;
  const headers = new Map<string, string[]>();
  let name = "";
  let value = "";
  const flush = () => {
    if (name) {
      const k = name.toLowerCase();
      const arr = headers.get(k) ?? [];
      arr.push(value);
      headers.set(k, arr);
    }
    name = "";
    value = "";
  };
  for (const line of headerBlock.split(/\r?\n/)) {
    if (/^[ \t]/.test(line)) {
      value += ` ${line.trim()}`;
    } else {
      flush();
      const idx = line.indexOf(":");
      if (idx !== -1) {
        name = line.slice(0, idx);
        value = line.slice(idx + 1).replace(/^[ \t]+/, "");
      }
    }
  }
  flush();
  return { headers, size, body };
}

export interface RunOptions {
  /** Override enabled extensions (default: ALL_EXTENSIONS). */
  enabledExtensions?: string[];
  /** Envelope from/to (defaults mirror the execution test fixtures). */
  from?: string;
  to?: string;
  /** Override message size (default: eml byte length). */
  size?: number;
  /** Extra loader options. */
  options?: Options;
}

/**
 * Load a script (all extensions enabled) and execute it against a message,
 * returning the accumulated Result. Throws on any load/execute error, so tests
 * for unimplemented features fail RED.
 */
export function run(scriptSrc: string, message = "", opts: RunOptions = {}): Result {
  const { headers, size, body } = parseEml(message);
  const script = load(scriptSrc, {
    enabledExtensions: opts.enabledExtensions ?? ALL_EXTENSIONS,
    ...opts.options,
  });
  const env = new EnvelopeStatic(opts.from ?? "from@test.com", opts.to ?? "to@test.com");
  const msg = new MessageStatic(opts.size ?? size, headers, body);
  const d = newRuntimeData(script, new DummyPolicy(), env, msg);
  script.execute(d);
  return {
    redirect: d.redirectAddr,
    fileinto: d.mailboxes,
    keep: d.keep,
    implicitKeep: d.implicitKeep,
    flags: d.flags,
  };
}

/** Load-only (compile) a script; throws on compile error. */
export function compile(scriptSrc: string, opts: RunOptions = {}): void {
  load(scriptSrc, { enabledExtensions: opts.enabledExtensions ?? ALL_EXTENSIONS, ...opts.options });
}

// Standard fixtures for the execution conformance tests.
export const eml = `Date: Tue, 1 Apr 1997 09:06:31 -0800 (PST)
From: coyote@desert.example.org
To: roadrunner@acme.example.com
Subject: I have a present for you

Look, I'm sorry about the whole anvil thing, and I really
didn't mean to try and drop it on you from the top of the
cliff.  I want to try to make it up to you.  I've got some
great birdseed over here at my place--top of the line
stuff--and if you come by, I'll have it all wrapped up
for you.  I'm really sorry for all the problems I've caused
for you over the years, but I know we can work this out.
--
Wile E. Coyote   "Super Genius"   coyote@desert.example.org
`;

export const emlSub = `Date: Tue, 1 Apr 1997 09:06:31 -0800 (PST)
From: ken+sieve@example.org
To: user+mailing-list@acme.example.com
Cc: admin+support@example.org
Subject: Test subaddress

Test message with subaddress
`;
