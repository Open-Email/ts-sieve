// @openemail/sieve — an RFC 5228 Sieve interpreter for TypeScript.
// Framework-agnostic: implement Message/Envelope/PolicyReader, load() a script,
// then execute it against a RuntimeData and read the accumulated actions
// (mailboxes, redirectAddr, flags, keep, implicitKeep).

export { SieveError } from "./errors.js";
export { load, defaultOptions, Script, type Options } from "./interp/script.js";
export {
  RuntimeData,
  newRuntimeData,
  DummyPolicy,
  EnvelopeStatic,
  MessageStatic,
  type Message,
  type Envelope,
  type PolicyReader,
  type Cmd,
  type Test,
  type Tri,
  type TestEnv,
  type SubTest,
  type Namespace,
} from "./interp/runtime.js";
export type { Comparator, Match, AddressPart } from "./interp/matching.js";
export type { VacationResponse } from "./interp/vacation.js";
export type { MailboxChecker } from "./interp/runtime.js";
export type { HeaderEdit } from "./interp/editheader.js";

// Low-level building blocks (useful for tooling: syntax highlighting, linting).
export { lex } from "./lexer/lex.js";
export { Stream } from "./lexer/stream.js";
export { parse } from "./parser/parse.js";
export type { Token } from "./lexer/token.js";
export type { Arg, Cmd as ParsedCmd, Test as ParsedTest } from "./parser/command.js";
