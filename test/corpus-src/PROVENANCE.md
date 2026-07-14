# Dovecot Pigeonhole conformance corpus — vendored third-party test data

This directory contains the Sieve `.svtest` / `.sieve` conformance corpus from the
Dovecot Pigeonhole project. It is **vendored** (checked into this repository as a
static snapshot) rather than fetched at build time, so the conformance suite keeps
working even if the upstream repository becomes unavailable.

## Source

- **Upstream:** https://github.com/dovecot/pigeonhole
- **Pinned commit:** `a1677bbe23cdb352704d07b2f2e6671fb66acb06`
  ("lib-sieve: ext-encoded-character - Fix integer overflow parsing unicode-hex")
- **Snapshot taken:** 2026-07-14
- **Vendored subtree:** `tests/` only (the corpus consumed by
  `test/dovecot/corpus.test.ts` and `test/dovecot/inline-compile.test.ts`).
  Upstream C source, build files (`Makefile.am`, `configure.ac`, `NEWS`, …) and
  the nested `.git` history are intentionally **not** included.

## License

The corpus is part of Dovecot Pigeonhole and is licensed under **LGPL-2.1**
(see `COPYING` and `COPYING.LGPL`; copyright holders in `AUTHORS`). This is
third-party material and retains its original license — it is aggregated with,
not merged into, this repository's MIT-licensed source. Do not relicense these
files.

## Re-syncing to a newer upstream

```sh
git clone --filter=blob:none --no-checkout https://github.com/dovecot/pigeonhole.git /tmp/pigeonhole
git -C /tmp/pigeonhole sparse-checkout set tests
git -C /tmp/pigeonhole checkout <new-commit>
rm -rf test/corpus-src/tests
cp -R /tmp/pigeonhole/tests test/corpus-src/tests
cp /tmp/pigeonhole/{AUTHORS,COPYING,COPYING.LGPL} test/corpus-src/
# then update the pinned commit + snapshot date above
```
