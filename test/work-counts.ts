// Test-only counters for primitive string work. Count the searched/copied span,
// not just calls: repeatedly scanning a long suffix must not look constant.
// Native regex backtracking is opaque here. Callers also pin an observed
// linear path (or the size of native search needles) so a replaced scanner
// cannot pass by avoiding the counted primitives entirely.
// Restore descriptors before any assertion, including when the work guard trips.
export function stringWork<T>(run: () => T, limit: number) {
  const calls: Record<string, number> = {};
  let units = 0;
  let maxIndexNeedle = 0;
  const restores: (() => void)[] = [];
  const patch = (owner: object, key: string, cost: (self: any, args: any[], result: any, from: number) => number) => {
    const descriptor = Object.getOwnPropertyDescriptor(owner, key)!;
    const original = descriptor.value;
    calls[key] = 0;
    Object.defineProperty(owner, key, { ...descriptor, value: function (this: any, ...args: any[]) {
      const from = owner === RegExp.prototype ? this.lastIndex : 0;
      const result = Reflect.apply(original, this, args);
      calls[key] = (calls[key] ?? 0) + 1;
      units += cost(this, args, result, from);
      if (units > limit) throw new Error(`string work exceeded ${limit} units in ${key}`);
      return result;
    } });
    restores.push(() => Object.defineProperty(owner, key, descriptor));
  };
  for (const key of ["charCodeAt", "codePointAt"]) patch(String.prototype, key, () => 1);
  patch(String.prototype, "indexOf", (s, [needle, start = 0], result) => {
    const from = Math.min(s.length, Math.max(0, start));
    maxIndexNeedle = Math.max(maxIndexNeedle, needle.length);
    return 1 + (result < 0 ? s.length - from : result - from + needle.length);
  });
  patch(String.prototype, "lastIndexOf", (s, [needle, start = s.length], result) => {
    const from = Math.min(s.length, Math.max(0, start));
    return 1 + (result < 0 ? from : from - result + needle.length);
  });
  for (const key of ["slice", "substring"]) patch(String.prototype, key, (_s, _args, result) => 1 + result.length);
  for (const key of ["toLowerCase", "trim", "trimEnd"]) patch(String.prototype, key, (s) => 1 + s.length);
  patch(String.prototype, "startsWith", (s, [needle]) => 1 + Math.min(s.length, needle.length));
  patch(RegExp.prototype, "exec", (re, [s], result, start) => {
    const from = re.global || re.sticky ? Math.min(s.length, start) : 0;
    return 1 + (result === null ? s.length - from : result.index - from + result[0].length);
  });
  try {
    const value = run();
    return { value, units, calls, maxIndexNeedle };
  } finally {
    for (const restore of restores.reverse()) restore();
  }
}
