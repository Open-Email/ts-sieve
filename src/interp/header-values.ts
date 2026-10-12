// Pure header transforms, memoized by raw content for one RuntimeData. Keep
// matching, marks and budget charges at the call sites: a cached parse is not
// a cached match, and repeated fields must still contribute to :count.
import { parseAddressList, stripRFC2822Comments } from "./address.js";
import { decodeHeaderValue } from "./header.js";
import type { RuntimeData } from "./runtime.js";

interface ParsedAddresses {
  clean: string;
  addresses: readonly { address: string }[] | null;
}

interface HeaderCache {
  decoded: Map<string, string>;
  parsed: Map<string, ParsedAddresses>;
  units: number;
  entries: number;
}

// UTF-16 units, counting raw keys and derived strings plus allowances for
// entries and address objects. A separate entry cap bounds tiny-value overhead.
// Admission stops at either limit; existing entries are never evicted, so a
// repeating sequence of large headers cannot churn the cache.
const MAX_UNITS = 4 * 1024 * 1024;
const MAX_ENTRIES = 4096;
const caches = new WeakMap<RuntimeData, HeaderCache>();

function cacheFor(d: RuntimeData): HeaderCache {
  let cache = caches.get(d);
  if (cache === undefined) {
    cache = { decoded: new Map(), parsed: new Map(), units: 0, entries: 0 };
    caches.set(d, cache);
  }
  return cache;
}

function remember<T>(cache: HeaderCache, map: Map<string, T>, raw: string, value: T, resultUnits: number): void {
  const units = raw.length + resultUnits + 64;
  if (cache.entries >= MAX_ENTRIES || cache.units + units > MAX_UNITS) return;
  map.set(raw, value);
  cache.units += units;
  cache.entries++;
}

export function decodeHeaderOnce(d: RuntimeData, raw: string): string {
  const cache = cacheFor(d);
  const held = cache.decoded.get(raw);
  if (held !== undefined) return held;
  const decoded = decodeHeaderValue(raw);
  remember(cache, cache.decoded, raw, decoded, decoded.length);
  return decoded;
}

export function parseHeaderAddressesOnce(d: RuntimeData, raw: string): ParsedAddresses {
  const cache = cacheFor(d);
  const held = cache.parsed.get(raw);
  if (held !== undefined) return held;
  const clean = stripRFC2822Comments(raw);
  let addresses: ParsedAddresses["addresses"];
  try {
    addresses = parseAddressList(clean);
  } catch {
    addresses = null; // Cache the failure too; callers retain literal fallback.
  }
  const parsed = { clean, addresses };
  let units = clean.length;
  if (addresses !== null) for (const a of addresses) units += 32 + a.address.length;
  remember(cache, cache.parsed, raw, parsed, units);
  return parsed;
}
