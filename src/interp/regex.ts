// A linear-time regular-expression engine — Thompson NFA compiled to a program
// and run with Pike's algorithm (submatch capture, leftmost-first priority).
//
// WHY NOT JS RegExp: :matches/:regex compile to a linear-time engine (RE2-style)
// (linear, no backtracking). JS RegExp backtracks and cannot be interrupted, so
// a hostile :regex or a long :matches glob would pin a Cloudflare Worker's CPU
// (ReDoS). This engine is O(program × input) with NO backtracking, so worst-case
// time is bounded by the (capped) pattern and (truncated) input. RE2-style
// features only: no backreferences, no lookaround (rejected at parse).

import { SieveError } from "../errors.js";

const MAX_PATTERN_LENGTH = 1000;
/** The match-input cut when the host sets no maxMatchInputLength. */
export const MAX_INPUT_LENGTH = 256 * 1024;
// {n,m} repetition is compiled by expansion, so a small count in the pattern can
// multiply into a huge program ("a{999999999}" is 12 chars). Cap the counts (like
// RE2's 1000) and the total compiled program size so compile work stays bounded
// even for nested repeats.
const MAX_REPEAT_COUNT = 1000;
const MAX_PROGRAM_SIZE = 10_000;
// The parser recurses once per group and the compiler once per level of the
// tree (a group, an alternation, a quantifier on anything), so both are capped
// well inside the call stack: an overflow is a RangeError, which no caller
// expects. Quantifiers stacked on groups deepen the tree without the parser
// seeing it, hence the second cap: "(((a**…)**…)**…)**…" is ~1000 levels deep.
const MAX_NESTING = 250;
const MAX_COMPILE_DEPTH = 500;
// The program-size cap bounds expansion only while every copy emits something:
// a repeat of a node that emits nothing ("(?:)", "(?i)") adds no instructions,
// so nested repeats of one went unchecked ("(?:(?:(?:(?:){1000}){1000}){1000}){1000}"
// is 10^12 calls). Compile calls are counted too. Work is about instructions
// times wrapper depth: real patterns need a few calls per instruction (2.5 at
// most in Pigeonhole's corpus), synthetic wrapping up to ~250x. Compile work
// is not charged to the step budget here; a caller compiling a key at run
// time charges it (matcher.ts runtimeKey), using compileWork.
export const MAX_COMPILE_WORK = 10 * MAX_PROGRAM_SIZE;

// ---------------------------------------------------------------------------
// AST
// ---------------------------------------------------------------------------

interface Flags {
  i: boolean; // case-insensitive (ASCII fold)
  s: boolean; // dotall (. matches \n)
  m: boolean; // multiline (^ $ at line boundaries)
}

type Node =
  | { t: "empty" }
  | { t: "lit"; cp: number; fold: boolean }
  | { t: "any"; dotall: boolean }
  | { t: "class"; ranges: [number, number][]; negated: boolean; fold: boolean }
  | { t: "concat"; parts: Node[] }
  | { t: "alt"; branches: Node[] }
  | { t: "star"; node: Node; lazy: boolean }
  | { t: "plus"; node: Node; lazy: boolean }
  | { t: "quest"; node: Node; lazy: boolean }
  | { t: "repeat"; node: Node; min: number; max: number; lazy: boolean }
  | { t: "group"; node: Node; cap: number | null }
  | { t: "assert"; kind: "bol" | "eol" | "bot" | "eot" | "wordb" | "nwordb" };

class Parser {
  private pos = 0;
  private capCount = 0;
  private depth = 0;
  constructor(private readonly src: string, private flags: Flags) {}

  parse(): { ast: Node; ncaps: number } {
    const ast = this.parseAlt();
    if (this.pos < this.src.length) throw new SieveError(`regex: unexpected ${this.src[this.pos]}`);
    return { ast, ncaps: this.capCount };
  }

  private peek(): string | undefined {
    return this.src[this.pos];
  }
  private eof(): boolean {
    return this.pos >= this.src.length;
  }

  private parseAlt(): Node {
    const branches: Node[] = [this.parseConcat()];
    while (this.peek() === "|") {
      this.pos++;
      branches.push(this.parseConcat());
    }
    return branches.length === 1 ? branches[0]! : { t: "alt", branches };
  }

  private parseConcat(): Node {
    const parts: Node[] = [];
    while (!this.eof() && this.peek() !== "|" && this.peek() !== ")") {
      parts.push(this.parseRepeat());
    }
    if (parts.length === 0) return { t: "empty" };
    return parts.length === 1 ? parts[0]! : { t: "concat", parts };
  }

  private parseRepeat(): Node {
    let node = this.parseAtom();
    for (;;) {
      const c = this.peek();
      if (c === "*" || c === "+" || c === "?") {
        this.pos++;
        const lazy = this.peek() === "?";
        if (lazy) this.pos++;
        node = c === "*" ? { t: "star", node, lazy } : c === "+" ? { t: "plus", node, lazy } : { t: "quest", node, lazy };
      } else if (c === "{") {
        const saved = this.pos;
        const rep = this.tryParseBrace();
        if (!rep) {
          this.pos = saved;
          break; // literal '{'
        }
        const lazy = this.peek() === "?";
        if (lazy) this.pos++;
        node = { t: "repeat", node, min: rep.min, max: rep.max, lazy };
      } else {
        break;
      }
    }
    return node;
  }

  private tryParseBrace(): { min: number; max: number } | null {
    // assumes current char is '{'
    this.pos++;
    const start = this.pos;
    while (!this.eof() && /[0-9]/.test(this.peek()!)) this.pos++;
    const minStr = this.src.slice(start, this.pos);
    if (minStr === "") return null;
    let max: number;
    if (this.peek() === "}") {
      max = Number.parseInt(minStr, 10);
      this.pos++;
    } else if (this.peek() === ",") {
      this.pos++;
      const s2 = this.pos;
      while (!this.eof() && /[0-9]/.test(this.peek()!)) this.pos++;
      const maxStr = this.src.slice(s2, this.pos);
      if (this.peek() !== "}") return null;
      this.pos++;
      max = maxStr === "" ? Infinity : Number.parseInt(maxStr, 10);
    } else {
      return null;
    }
    const min = Number.parseInt(minStr, 10);
    if (min > MAX_REPEAT_COUNT || (max !== Infinity && max > MAX_REPEAT_COUNT)) {
      throw new SieveError("regex: repetition count too large");
    }
    if (max !== Infinity && max < min) throw new SieveError("regex: invalid repetition range");
    return { min, max };
  }

  private parseAtom(): Node {
    const c = this.peek();
    if (c === "(") return this.parseGroup();
    if (c === "[") return this.parseClass();
    if (c === ".") {
      this.pos++;
      return { t: "any", dotall: this.flags.s };
    }
    if (c === "^") {
      this.pos++;
      return { t: "assert", kind: this.flags.m ? "bol" : "bot" };
    }
    if (c === "$") {
      this.pos++;
      return { t: "assert", kind: this.flags.m ? "eol" : "eot" };
    }
    if (c === "\\") return this.parseEscape();
    if (c === undefined || c === ")" || c === "|" || c === "*" || c === "+" || c === "?") {
      throw new SieveError(`regex: unexpected token ${c ?? "EOF"}`);
    }
    // Read a full code point (not a UTF-16 unit): the VM input is code points,
    // so splitting a surrogate pair here would make astral literals unmatchable.
    const cp = this.src.codePointAt(this.pos)!;
    this.pos += String.fromCodePoint(cp).length;
    return { t: "lit", cp, fold: this.flags.i };
  }

  private parseGroup(): Node {
    if (++this.depth > MAX_NESTING) throw new SieveError("regex: nested too deeply");
    const node = this.parseGroupBody();
    this.depth--;
    return node;
  }

  private parseGroupBody(): Node {
    this.pos++; // (
    if (this.peek() === "?") {
      this.pos++;
      const c = this.peek();
      if (c === ":" || c === "i" || c === "s" || c === "m") {
        // inline flags: (?flags) or (?flags:...)
        const saved = { ...this.flags };
        while (!this.eof() && /[ism]/.test(this.peek()!)) {
          const f = this.peek()!;
          this.flags = { ...this.flags, [f]: true };
          this.pos++;
        }
        if (this.peek() === ")") {
          this.pos++;
          return { t: "empty" }; // (?flags) applies to the rest of the group
        }
        if (this.peek() !== ":") throw new SieveError("regex: bad inline flags");
        this.pos++;
        const node = this.parseAlt();
        if (this.peek() !== ")") throw new SieveError("regex: missing )");
        this.pos++;
        this.flags = saved; // scoped flags
        return { t: "group", node, cap: null };
      }
      if (c === "=" || c === "!" || c === "<") throw new SieveError("regex: lookaround not supported");
      throw new SieveError(`regex: unsupported group (?${c ?? ""}`);
    }
    const cap = this.capCount++;
    const node = this.parseAlt();
    if (this.peek() !== ")") throw new SieveError("regex: missing )");
    this.pos++;
    return { t: "group", node, cap };
  }

  private parseClass(): Node {
    this.pos++; // [
    let negated = false;
    if (this.peek() === "^") {
      negated = true;
      this.pos++;
    }
    const ranges: [number, number][] = [];
    let first = true;
    while (!this.eof() && (this.peek() !== "]" || first)) {
      first = false;
      let lo: number;
      if (this.peek() === "\\") {
        const esc = this.parseClassEscape();
        if (Array.isArray(esc)) {
          ranges.push(...esc);
          continue;
        }
        lo = esc;
      } else {
        lo = this.src.codePointAt(this.pos)!;
        this.pos += String.fromCodePoint(lo).length;
      }
      if (this.peek() === "-" && this.src[this.pos + 1] !== "]" && this.pos + 1 < this.src.length) {
        this.pos++; // -
        let hi: number;
        if (this.peek() === "\\") {
          const esc = this.parseClassEscape();
          hi = Array.isArray(esc) ? lo : esc; // range to a class escape is degenerate; treat as literal lo
        } else {
          hi = this.src.codePointAt(this.pos)!;
          this.pos += String.fromCodePoint(hi).length;
        }
        ranges.push([lo, hi]);
      } else {
        ranges.push([lo, lo]);
      }
    }
    if (this.peek() !== "]") throw new SieveError("regex: missing ]");
    this.pos++;
    return { t: "class", ranges: normalizeRanges(ranges), negated, fold: this.flags.i };
  }

  private parseClassEscape(): number | [number, number][] {
    this.pos++; // backslash
    const c = this.peek();
    if (c === undefined) throw new SieveError("regex: trailing backslash in class");
    this.pos++;
    switch (c) {
      case "d":
        return [[48, 57]];
      case "D":
        return negate([[48, 57]]);
      case "w":
        return WORD_RANGES.slice();
      case "W":
        return negate(WORD_RANGES);
      case "s":
        return SPACE_RANGES.slice();
      case "S":
        return negate(SPACE_RANGES);
      case "n":
        return 10;
      case "r":
        return 13;
      case "t":
        return 9;
      case "f":
        return 12;
      case "v":
        return 11;
      case "0":
        return 0;
      default: {
        // Re-read as a full code point (peek() yields one UTF-16 unit).
        this.pos--;
        const cp = this.src.codePointAt(this.pos)!;
        this.pos += String.fromCodePoint(cp).length;
        return cp;
      }
    }
  }

  private parseEscape(): Node {
    this.pos++; // backslash
    const c = this.peek();
    if (c === undefined) throw new SieveError("regex: trailing backslash");
    this.pos++;
    switch (c) {
      case "d":
        return { t: "class", ranges: [[48, 57]], negated: false, fold: false };
      case "D":
        return { t: "class", ranges: [[48, 57]], negated: true, fold: false };
      case "w":
        return { t: "class", ranges: normalizeRanges(WORD_RANGES), negated: false, fold: false };
      case "W":
        return { t: "class", ranges: normalizeRanges(WORD_RANGES), negated: true, fold: false };
      case "s":
        return { t: "class", ranges: normalizeRanges(SPACE_RANGES), negated: false, fold: false };
      case "S":
        return { t: "class", ranges: normalizeRanges(SPACE_RANGES), negated: true, fold: false };
      case "b":
        return { t: "assert", kind: "wordb" };
      case "B":
        return { t: "assert", kind: "nwordb" };
      case "A":
        return { t: "assert", kind: "bot" };
      case "z":
        return { t: "assert", kind: "eot" };
      case "n":
        return { t: "lit", cp: 10, fold: false };
      case "r":
        return { t: "lit", cp: 13, fold: false };
      case "t":
        return { t: "lit", cp: 9, fold: false };
      case "f":
        return { t: "lit", cp: 12, fold: false };
      case "v":
        return { t: "lit", cp: 11, fold: false };
      default: {
        if (c >= "1" && c <= "9") throw new SieveError("regex: backreferences not supported");
        // Re-read as a full code point (peek() yields one UTF-16 unit).
        this.pos--;
        const cp = this.src.codePointAt(this.pos)!;
        this.pos += String.fromCodePoint(cp).length;
        return { t: "lit", cp, fold: this.flags.i };
      }
    }
  }
}

const WORD_RANGES: [number, number][] = [
  [48, 57],
  [65, 90],
  [97, 122],
  [95, 95],
];
const SPACE_RANGES: [number, number][] = [
  [9, 10],
  [11, 13],
  [32, 32],
];

function negate(ranges: [number, number][]): [number, number][] {
  // Complement within [0, 0x10FFFF]. Callers use this only inside a class where
  // the surrounding negated flag is false, so the returned ranges are positive.
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  let prev = 0;
  for (const [lo, hi] of sorted) {
    if (lo > prev) out.push([prev, lo - 1]);
    prev = Math.max(prev, hi + 1);
  }
  if (prev <= 0x10ffff) out.push([prev, 0x10ffff]);
  return out;
}

/** Sort ranges and merge the overlapping or adjacent ones, into new tuples
 * (WORD_RANGES and the like are shared and must not change), so a class is
 * matched by binary search. Done once per class node, when it is parsed: every
 * class node is built by parseClass or parseEscape. A reversed range ("z-a")
 * stays empty. */
function normalizeRanges(ranges: [number, number][]): [number, number][] {
  if (ranges.length === 0) return [];
  const sorted = ranges.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out: [number, number][] = [];
  let curLo = sorted[0]![0];
  let curHi = sorted[0]![1];
  for (let i = 1; i < sorted.length; i++) {
    const [nextLo, nextHi] = sorted[i]!;
    if (nextLo <= curHi + 1) {
      if (nextHi > curHi) curHi = nextHi;
    } else {
      out.push([curLo, curHi]);
      curLo = nextLo;
      curHi = nextHi;
    }
  }
  out.push([curLo, curHi]);
  return out;
}

// ---------------------------------------------------------------------------
// Compiler → program
// ---------------------------------------------------------------------------

type Inst =
  | { op: "char"; cp: number; fold: boolean }
  | { op: "any"; dotall: boolean }
  | { op: "class"; ranges: [number, number][]; negated: boolean; fold: boolean }
  | { op: "split"; x: number; y: number }
  | { op: "jmp"; x: number }
  | { op: "save"; slot: number }
  | { op: "assert"; kind: "bol" | "eol" | "bot" | "eot" | "wordb" | "nwordb" }
  | { op: "match" };

class Compiler {
  prog: Inst[] = [];
  private depth = 0;
  work = 0;
  emit(i: Inst): number {
    if (this.prog.length >= MAX_PROGRAM_SIZE) throw new SieveError("regex: compiled program too large");
    this.prog.push(i);
    return this.prog.length - 1;
  }
  compile(node: Node): void {
    if (++this.work > MAX_COMPILE_WORK) throw new SieveError("regex: pattern too complex to compile");
    if (++this.depth > MAX_COMPILE_DEPTH) throw new SieveError("regex: nested too deeply");
    try {
      switch (node.t) {
        case "empty":
          return;
        case "lit":
          this.emit({ op: "char", cp: node.cp, fold: node.fold });
          return;
        case "any":
          this.emit({ op: "any", dotall: node.dotall });
          return;
        case "class":
          // Ranges were normalized when the node was parsed. A repeat compiles
          // its node once per copy, and every copy shares this one array.
          this.emit({ op: "class", ranges: node.ranges, negated: node.negated, fold: node.fold });
          return;
        case "assert":
          this.emit({ op: "assert", kind: node.kind });
          return;
        case "concat":
          for (const p of node.parts) this.compile(p);
          return;
        case "group":
          if (node.cap !== null) this.emit({ op: "save", slot: 2 * node.cap + 2 });
          this.compile(node.node);
          if (node.cap !== null) this.emit({ op: "save", slot: 2 * node.cap + 3 });
          return;
        case "alt": {
          const jmps: number[] = [];
          for (let i = 0; i < node.branches.length; i++) {
            if (i < node.branches.length - 1) {
              const split = this.emit({ op: "split", x: 0, y: 0 });
              (this.prog[split] as { x: number }).x = this.prog.length;
              this.compile(node.branches[i]!);
              jmps.push(this.emit({ op: "jmp", x: 0 }));
              (this.prog[split] as { y: number }).y = this.prog.length;
            } else {
              this.compile(node.branches[i]!);
            }
          }
          for (const j of jmps) (this.prog[j] as { x: number }).x = this.prog.length;
          return;
        }
        case "star": {
          const split = this.emit({ op: "split", x: 0, y: 0 });
          const bodyStart = this.prog.length;
          this.compile(node.node);
          this.emit({ op: "jmp", x: split });
          const after = this.prog.length;
          const s = this.prog[split] as { x: number; y: number };
          if (node.lazy) {
            s.x = after;
            s.y = bodyStart;
          } else {
            s.x = bodyStart;
            s.y = after;
          }
          return;
        }
        case "plus": {
          const bodyStart = this.prog.length;
          this.compile(node.node);
          const split = this.emit({ op: "split", x: 0, y: 0 });
          const after = this.prog.length;
          const s = this.prog[split] as { x: number; y: number };
          if (node.lazy) {
            s.x = after;
            s.y = bodyStart;
          } else {
            s.x = bodyStart;
            s.y = after;
          }
          return;
        }
        case "quest": {
          const split = this.emit({ op: "split", x: 0, y: 0 });
          const bodyStart = this.prog.length;
          this.compile(node.node);
          const after = this.prog.length;
          const s = this.prog[split] as { x: number; y: number };
          if (node.lazy) {
            s.x = after;
            s.y = bodyStart;
          } else {
            s.x = bodyStart;
            s.y = after;
          }
          return;
        }
        case "repeat": {
          const min = node.min;
          const max = node.max;
          for (let i = 0; i < min; i++) this.compile(node.node);
          if (max === Infinity) {
            this.compile({ t: "star", node: node.node, lazy: node.lazy });
          } else {
            for (let i = min; i < max; i++) this.compile({ t: "quest", node: node.node, lazy: node.lazy });
          }
          return;
        }
      }
    } finally {
      this.depth--;
    }
  }
}

// ---------------------------------------------------------------------------
// Pike VM
// ---------------------------------------------------------------------------

function foldASCII(cp: number): number {
  return cp >= 65 && cp <= 90 ? cp + 32 : cp;
}
function isWord(cp: number): boolean {
  return (cp >= 48 && cp <= 57) || (cp >= 65 && cp <= 90) || (cp >= 97 && cp <= 122) || cp === 95;
}

/** Whether cp lies in sorted, merged ranges: O(log n), so a class of many
 * ranges costs about what the one budget step charged for it allows. */
function binarySearchRanges(ranges: [number, number][], cp: number): boolean {
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const r = ranges[mid]!;
    if (cp < r[0]) hi = mid - 1;
    else if (cp > r[1]) lo = mid + 1;
    else return true;
  }
  return false;
}

function classMatch(inst: { ranges: [number, number][]; negated: boolean; fold: boolean }, cp: number): boolean {
  let hit = binarySearchRanges(inst.ranges, cp);
  if (!hit && inst.fold) {
    const swapped = cp >= 65 && cp <= 90 ? cp + 32 : cp >= 97 && cp <= 122 ? cp - 32 : cp;
    if (swapped !== cp) hit = binarySearchRanges(inst.ranges, swapped);
  }
  return inst.negated ? !hit : hit;
}

/** Cooperative budget hook (RuntimeData.budget); throws when exhausted. */
interface StepBudget {
  consume(n?: number): void;
}

export interface CompiledRegex {
  /** Compile calls it took (see MAX_COMPILE_WORK). */
  readonly compileWork: number;
  /** Whether the pattern holds an assertion decided by what follows the
   * matched text (`$`, `\z`, `\b`, `\B`): at the end of a cut input nothing
   * follows, though the whole input goes on. */
  readonly endSensitive: boolean;
  /** `info.atEnd`, when given, is set to whether the match ends at the end of
   * the input matched (after maxInputLength's cut). */
  findSubmatch(input: string, opts?: { maxInputLength?: number; budget?: StepBudget; info?: { atEnd: boolean } }): string[] | null;
}

class Program implements CompiledRegex {
  readonly endSensitive: boolean;

  constructor(
    private readonly prog: Inst[],
    private readonly ncaps: number,
    readonly compileWork: number,
  ) {
    this.endSensitive = prog.some(
      (i) => i.op === "assert" && (i.kind === "eot" || i.kind === "eol" || i.kind === "wordb" || i.kind === "nwordb"),
    );
  }

  findSubmatch(inputStr: string, opts?: { maxInputLength?: number; budget?: StepBudget; info?: { atEnd: boolean } }): string[] | null {
    const maxInput = opts?.maxInputLength ?? MAX_INPUT_LENGTH;
    const budget = opts?.budget;
    // Byte-truncate the input before matching.
    let s = inputStr;
    if (byteLen(s) > maxInput) s = truncateToBytes(s, maxInput);
    const input = Array.from(s, (ch) => ch.codePointAt(0)!);
    const nslots = 2 * this.ncaps + 2;

    const checkAssert = (kind: string, sp: number): boolean => {
      switch (kind) {
        case "bot":
          return sp === 0;
        case "eot":
          return sp === input.length;
        case "bol":
          return sp === 0 || input[sp - 1] === 10;
        case "eol":
          return sp === input.length || input[sp] === 10;
        case "wordb":
          return (sp > 0 && isWord(input[sp - 1]!)) !== (sp < input.length && isWord(input[sp]!));
        case "nwordb":
          return (sp > 0 && isWord(input[sp - 1]!)) === (sp < input.length && isWord(input[sp]!));
        default:
          return false;
      }
    };

    type Thread = { pc: number; caps: number[] };
    // Follow the epsilon instructions (jmp, split, save, assert) from pc and
    // add the threads they reach to `list`, in priority order. A depth-first
    // walk without recursion: it recursed once per instruction, and the
    // program-size cap allows epsilon chains longer than the call stack
    // ("(?:^{1000}){9}"). Single-successor instructions are followed in place;
    // a split's second branch waits on the stack under everything its first
    // reaches, which is the order the recursion visited them in.
    const pendingPc: number[] = [];
    const pendingCaps: number[][] = [];
    const addThread = (list: Thread[], visited: Set<number>, pc0: number, sp: number, caps0: number[]): void => {
      pendingPc.push(pc0);
      pendingCaps.push(caps0);
      while (pendingPc.length > 0) {
        let pc = pendingPc.pop()!;
        let caps = pendingCaps.pop()!;
        for (;;) {
          if (visited.has(pc)) break;
          visited.add(pc);
          budget?.consume(1); // bound VM work: at most program × input (pc,sp) visits
          const inst = this.prog[pc]!;
          if (inst.op === "jmp") {
            pc = inst.x;
          } else if (inst.op === "split") {
            pendingPc.push(inst.y);
            pendingCaps.push(caps);
            pc = inst.x;
          } else if (inst.op === "save") {
            caps = caps.slice();
            caps[inst.slot] = sp;
            pc++;
          } else if (inst.op === "assert") {
            if (!checkAssert(inst.kind, sp)) break;
            pc++;
          } else {
            list.push({ pc, caps });
            break;
          }
        }
      }
    };

    let clist: Thread[] = [];
    let cvisited = new Set<number>();
    addThread(clist, cvisited, 0, 0, new Array(nslots).fill(-1));
    let matched: number[] | null = null;

    for (let sp = 0; sp <= input.length; sp++) {
      const cp = sp < input.length ? input[sp]! : -1;
      const nlist: Thread[] = [];
      const nvisited = new Set<number>();
      for (let ti = 0; ti < clist.length; ti++) {
        const th = clist[ti]!;
        const inst = this.prog[th.pc]!;
        if (inst.op === "match") {
          const startPos = th.caps[0] ?? -1;
          const caps = th.caps.slice();
          caps[0] = startPos === -1 ? 0 : startPos;
          caps[1] = sp;
          matched = caps;
          break; // leftmost-first: prune lower-priority threads
        }
        let consume = false;
        if (inst.op === "char") consume = cp !== -1 && (inst.fold ? foldASCII(cp) === foldASCII(inst.cp) : cp === inst.cp);
        else if (inst.op === "any") consume = cp !== -1 && (inst.dotall || cp !== 10);
        else if (inst.op === "class") consume = cp !== -1 && classMatch(inst, cp);
        if (consume) addThread(nlist, nvisited, th.pc + 1, sp + 1, th.caps);
      }
      // Unanchored leftmost search: seed a fresh start thread at the next
      // position (lowest priority) until a match is found.
      if (matched === null && sp < input.length) {
        const startCaps = new Array(nslots).fill(-1);
        startCaps[0] = sp + 1;
        addThread(nlist, nvisited, 0, sp + 1, startCaps);
      }
      clist = nlist;
      cvisited = nvisited;
      // Stop early only once a match is in hand. An empty thread list does NOT
      // mean the search is over: the seed thread for the next position is added
      // above and can DIE IMMEDIATELY inside addThread when the program starts
      // with a zero-width assertion that fails there (`\b`, `\B`, `(?m)^`).
      // Breaking on empty therefore abandoned every later start position —
      // `\bcat\b` found nothing in "the cat sat" because the seed at offset 1
      // sits inside a word. Later iterations cost one empty pass each, which is
      // the same O(n·m) bound the VM already carries.
      if (clist.length === 0 && matched !== null) break;
    }

    if (matched === null) return null;
    if (opts?.info) opts.info.atEnd = matched[1] === input.length;
    const out: string[] = [];
    for (let i = 0; i < nslots; i += 2) {
      const a = matched[i]!;
      const b = matched[i + 1]!;
      out.push(a >= 0 && b >= 0 ? fromCodePoints(input, a, b) : "");
    }
    return out;
  }
}

/** A capture as a string. Spread in chunks of 4096: a spread passes its
 * elements on the call stack, so one of the whole capture overflows it past
 * ~100k code points (the input is cut at MAX_INPUT_LENGTH, 256 KiB, unless
 * the host sets another maxMatchInputLength), and chunks of 0x8000 still took
 * ~200 KB of it. */
function fromCodePoints(cps: number[], start: number, end: number): string {
  let s = "";
  for (let i = start; i < end; i += 0x1000) s += String.fromCodePoint(...cps.slice(i, Math.min(end, i + 0x1000)));
  return s;
}

const encoder = new TextEncoder();
/** UTF-8 byte length — the unit findSubmatch's maxInputLength cut is measured
 * in, exported so a caller can detect that the cut applied to its input. */
export function byteLen(s: string): number {
  return encoder.encode(s).length;
}
/** The longest prefix of s within maxBytes. A character the byte cut splits is
 * dropped, not decoded as U+FFFD: the cut input is matched as a prefix of the
 * real one, and a U+FFFD there is content the real input does not have. */
function truncateToBytes(s: string, maxBytes: number): string {
  const bytes = encoder.encode(s);
  return new TextDecoder().decode(bytes.subarray(0, maxBytes), { stream: true });
}

/** Compile a regex pattern, enforcing the compile-time pattern-length cap. */
export function compileRegex(
  pattern: string,
  opts?: { maxPatternLength?: number; caseInsensitive?: boolean },
): CompiledRegex {
  const cap = opts?.maxPatternLength ?? MAX_PATTERN_LENGTH;
  if (pattern.length > cap) throw new SieveError(`regex pattern too long: ${pattern.length} > ${cap}`);
  // `caseInsensitive` seeds the parser's initial flag state — the same fold an
  // inline leading `(?i)` would set, but WITHOUT rewriting the pattern text:
  // a textual prefix shifts parse positions, so `*abc` (a load-time refusal —
  // nothing for the quantifier to bind) would silently become legal as
  // `(?i)*abc`. Used by `:regex` under casemap comparators.
  const parser = new Parser(pattern, { i: opts?.caseInsensitive ?? false, s: false, m: false });
  const { ast, ncaps } = parser.parse();
  const compiler = new Compiler();
  // A leading Save(0) is implicit via the seed caps; add trailing Match.
  compiler.compile(ast);
  compiler.emit({ op: "match" });
  return new Program(compiler.prog, ncaps, compiler.work);
}

/**
 * Translate a Sieve `:matches` glob into a regex string: `*`→lazy capture
 * `(.*?)`, `?`→`(.)`, escapes, anchored `(?s)^…$`, plus `(?i)` when caseFold.
 * Every wildcard is a capture group, so ${N} counts both `*` and `?`.
 *
 * A trailing backslash is treated as a literal backslash, with the match still
 * anchored.
 */
export function patternToRegex(pattern: string, caseFold: boolean): string {
  let out = "(?s)";
  if (caseFold) out += "(?i)";
  out += "^";
  let escaped = false;
  for (const ch of pattern) {
    if (!escaped) {
      if (ch === "\\") escaped = true;
      else if (ch === "?") out += "(.)";
      else if (ch === "*") out += "(.*?)";
      else if (".+()|[]{}^$".includes(ch)) out += `\\${ch}`;
      else out += ch;
    } else {
      if ("\\?*.+()|[]{}^$".includes(ch)) out += `\\${ch}`;
      else out += ch;
      escaped = false;
    }
  }
  if (escaped) out += "\\\\"; // trailing backslash matches a literal backslash
  return `${out}$`;
}
