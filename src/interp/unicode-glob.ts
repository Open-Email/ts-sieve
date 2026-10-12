// Unicode :matches: compare prepared literals while wildcards consume original
// code points. A decomposition must not become syntax, split a '?' character,
// or replace the text returned in ${N}. This is a bounded, ordered NFA: no
// backtracking, one active thread per pattern position at each source character.
import { SieveError } from "../errors.js";
import { toUnicodeCasemapFold } from "./matching.js";
import { MAX_UNICODE_CASEMAP_EXPANSION } from "./unicode-casemap-data.js";
import { type CompiledRegex, MAX_INPUT_LENGTH, byteLen, patternToRegex, truncateToBytes } from "./regex.js";

type Token = { kind: "literal"; char: string } | { kind: "star" | "any"; group: number };
type Thread = { pc: number; caps: number[] };

export function compileUnicodeGlob(pattern: string): CompiledRegex {
  // Keep the same uploaded/dynamic pattern limit as the other glob engine.
  if (patternToRegex(pattern, false).length > 1000) throw new SieveError("regex pattern too long");
  const tokens: Token[] = [];
  let groups = 0;
  let escaped = false;
  const literal = (ch: string) => {
    for (const char of toUnicodeCasemapFold(ch)) tokens.push({ kind: "literal", char });
    if (tokens.length > 10_000) throw new SieveError("Unicode glob program too large");
  };
  for (const ch of pattern) {
    if (escaped) { literal(ch); escaped = false; }
    else if (ch === "\\") escaped = true;
    else if (ch === "*" || ch === "?") tokens.push({ kind: ch === "*" ? "star" : "any", group: ++groups });
    else literal(ch);
  }
  if (escaped) literal("\\");
  return {
    // Reserves include the table's largest per-character expansion. Execution
    // charges the actual transitions, so a long decomposed input stays bounded.
    programSize: (tokens.length + 1) * MAX_UNICODE_CASEMAP_EXPANSION,
    compileWork: tokens.length + pattern.length,
    findSubmatch(source, opts) {
      const limit = opts?.maxInputLength ?? MAX_INPUT_LENGTH;
      const value = byteLen(source) > limit ? truncateToBytes(source, limit) : source;
      const budget = opts?.budget;
      const add = (list: Thread[], seen: Set<number>, initial: Thread, pos: number) => {
        let { pc, caps } = initial;
        const stars: Thread[] = [];
        // Lazy stars try the empty arm first, matching the existing regex VM.
        for (;;) {
          if (seen.has(pc)) break;
          seen.add(pc);
          budget?.consume(1);
          const token = tokens[pc];
          if (token?.kind !== "star") { list.push({ pc, caps }); break; }
          if (caps[token.group * 2] === -1) {
            caps = caps.slice();
            caps[token.group * 2] = caps[token.group * 2 + 1] = pos;
          }
          stars.push({ pc, caps });
          pc++;
        }
        for (let i = stars.length - 1; i >= 0; i--) list.push(stars[i]!);
      };
      let active: Thread[] = [];
      add(active, new Set(), { pc: 0, caps: new Array(2 * groups + 2).fill(-1) }, 0);
      let pos = 0;
      for (const ch of value) {
        const end = pos + ch.length;
        const folded = [...toUnicodeCasemapFold(ch)];
        const next: Thread[] = [];
        const seen = new Set<number>();
        for (const thread of active) {
          const token = tokens[thread.pc];
          if (!token) continue;
          budget?.consume(1);
          if (token.kind === "literal") {
            let pc = thread.pc;
            let matched = true;
            for (const char of folded) {
              budget?.consume(1);
              const t = tokens[pc++];
              if (t?.kind !== "literal" || t.char !== char) { matched = false; break; }
            }
            if (matched) add(next, seen, { pc, caps: thread.caps }, end);
          } else {
            const caps = thread.caps.slice();
            if (token.kind === "any") caps[2 * token.group] = pos;
            caps[2 * token.group + 1] = end;
            add(next, seen, { pc: thread.pc + (token.kind === "any" ? 1 : 0), caps }, end);
          }
        }
        active = next;
        pos = end;
        if (active.length === 0) return null;
      }
      const matched = active.find(t => t.pc === tokens.length);
      if (!matched) return null;
      const out = [value];
      for (let g = 1; g <= groups; g++) out.push(value.slice(matched.caps[2 * g]!, matched.caps[2 * g + 1]!));
      return out;
    },
  };
}
