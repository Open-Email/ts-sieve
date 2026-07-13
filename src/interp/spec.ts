// The loader spec type surface. LoadSpec itself lives in load.ts (it recurses
// through LoadTest/LoadBlock).

import type { Cmd, Test } from "./runtime.js";

export interface SpecTag {
  needsValue?: boolean;
  matchStr?: (val: string[]) => void;
  matchNum?: (val: number) => void;
  matchBool?: () => void;
  minStrCount?: number;
  maxStrCount?: number;
  noVariables?: boolean;
}

export interface SpecPosArg {
  optional?: boolean;
  matchStr?: (val: string[]) => void;
  matchNum?: (i: number) => void;
  minStrCount?: number;
  maxStrCount?: number;
  noVariables?: boolean;
}

export interface Spec {
  tags?: Record<string, SpecTag>;
  pos?: SpecPosArg[];
  addBlock?: (cmds: Cmd[]) => void;
  blockOptional?: boolean;
  addTest?: (t: Test) => void;
  testOptional?: boolean;
  multipleTests?: boolean;
}
