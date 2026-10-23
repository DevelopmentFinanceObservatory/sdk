import { CLIENT_WARNING_CODES } from "../generated/warning-codes.ts";
import { printable } from "./text.ts";

/** The base of every warning the client emits. Its message drops the characters that steer a
 *  terminal or reorder text, since it can quote the server. */
export class DfoWarning extends Error {
  /** The server's warning or departure code, or null for a `SearchWarning` whose readings
   *  differ from the question in several ways. */
  readonly code: string | null;
  /** For a `DataWarning` or a `SearchWarning`, the trace id of the response that carried it,
   *  to quote when reporting it; else null. */
  readonly traceId: string | null;

  constructor(code: string | null, message: string, traceId: string | null = null) {
    super(printable(message));
    this.code = code;
    this.traceId = traceId;
  }
}

/** The server marks a route deprecated (`Deprecation`), perhaps with a removal date (`Sunset`). */
export class DfoDeprecationWarning extends DfoWarning {}

/** A warning the server attached to a dataset's manifest, above `info` severity. */
export class DataWarning extends DfoWarning {
  declare readonly code: string;
  /** The server's severity for it. */
  readonly severity: string;

  constructor(code: string, message: string, severity: string, traceId: string | null = null) {
    super(code, message, traceId);
    this.severity = severity;
  }
}

const WARNING_CLASSES = { DfoWarning, DfoDeprecationWarning, DataWarning };

for (const [name, warningClass] of Object.entries(WARNING_CLASSES)) {
  Object.defineProperty(warningClass.prototype, "name", { value: name, configurable: true });
}

/** A code the client sets on a warning it issues itself. */
export type ClientWarningCode = keyof typeof CLIENT_WARNING_CODES;

/** Builds a warning the client issues itself, of the class `contract/warning-codes.json` gives
 *  its code. A `DataWarning` carries a manifest warning's code and a `SearchWarning` the code of
 *  how a reading differs, both the server's, so neither is built here. */
export function clientWarning(code: ClientWarningCode, message: string): DfoWarning {
  return new WARNING_CLASSES[CLIENT_WARNING_CODES[code]](code, message);
}

/** Receives each warning the client emits. */
export type WarningHandler = (warning: DfoWarning) => void;

type ProcessLike = { emitWarning?: (warning: Error) => void };

/** Emits through `process.emitWarning` where the platform has it, else `console.warn`. */
export const emitWarning: WarningHandler = (warning) => {
  const emit = (globalThis as { process?: ProcessLike }).process?.emitWarning;
  if (typeof emit === "function") {
    emit.call((globalThis as { process?: ProcessLike }).process, warning);
  } else {
    console.warn(`${warning.name}: ${warning.message}`);
  }
};

/** The keys `warnOnce` has seen. At `WARNED_MAX` the set starts again, so a server that sends a
 *  new warning with every response cannot grow it without bound; a warning seen before the
 *  restart can show once more. */
const WARNED_MAX = 1024;
const shown = new Set<string>();

/** Emits a warning the first time its key is seen in this process. */
export function warnOnce(key: string, warning: DfoWarning, handler: WarningHandler): void {
  if (shown.has(key)) return;
  if (shown.size >= WARNED_MAX) shown.clear();
  shown.add(key);
  handler(warning);
}

/** @internal Forgets every warning `warnOnce` has emitted, as a fresh process starts. The
 *  contract replay calls it before each scenario. */
export function forgetEmittedWarnings(): void {
  shown.clear();
}
