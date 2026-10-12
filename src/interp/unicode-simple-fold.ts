// Regex characters use one-code-point default simple case folding (UTS #18
// RL1.5). Unlike the RFC 5051 string/glob preparation, this does not decompose
// characters or change the number of characters a quantifier consumes.
import { UNICODE_SIMPLE_FOLD } from "./unicode-simple-fold-data.js";
export function simpleFold(cp: number): number { return UNICODE_SIMPLE_FOLD.get(cp) ?? cp; }

const variants = new Map<number, number[]>();
for (const [cp, folded] of UNICODE_SIMPLE_FOLD) {
  let group = variants.get(folded);
  if (!group) variants.set(folded, (group = [folded]));
  group.push(cp);
}
/** Only characters with a nontrivial equivalence class, in numeric order. */
export const SIMPLE_FOLD_POINTS: readonly number[] = [...new Set([...UNICODE_SIMPLE_FOLD.keys(), ...variants.keys()])].sort((a,b) => a-b);
export function simpleFoldVariants(cp: number): readonly number[] { return variants.get(simpleFold(cp)) ?? [cp]; }
