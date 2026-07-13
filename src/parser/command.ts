// The low-level AST.
//
// Args are a discriminated union (number/string/stringList/tag). `Test`/`Cmd`
// carry positions. A Cmd's `block` is null when the command has no `{ }` block,
// distinct from an empty block `{}` (an empty array).

export interface Position {
  line: number;
  col: number;
}

export type Arg =
  | ({ kind: "number"; value: number } & Position)
  | ({ kind: "string"; value: string } & Position)
  | ({ kind: "stringList"; value: string[] } & Position)
  | ({ kind: "tag"; value: string } & Position);

export interface Test extends Position {
  id: string;
  args: Arg[];
  tests: Test[];
}

export interface Cmd extends Position {
  id: string;
  args: Arg[];
  tests: Test[];
  block: Cmd[] | null;
}
