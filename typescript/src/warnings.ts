/** The base of every warning the client emits. */
export class DfoWarning extends Error {
  /** The server's warning or departure code, or null for a `SearchWarning` whose readings
   *  differ from the question in several ways. */
  readonly code: string | null;

  constructor(code: string | null, message: string) {
    super(message);
    this.code = code;
  }
}

/** The server marks a route deprecated (`Deprecation`), perhaps with a removal date (`Sunset`). */
export class DfoDeprecationWarning extends DfoWarning {}

/** A warning the server attached to a dataset's manifest, above `info` severity. */
export class DataWarning extends DfoWarning {
  declare readonly code: string;
  /** The server's severity for it. */
  readonly severity: string;

  constructor(code: string, message: string, severity: string) {
    super(code, message);
    this.severity = severity;
  }
}

const WARNING_CLASSES = { DfoWarning, DfoDeprecationWarning, DataWarning };

for (const [name, warningClass] of Object.entries(WARNING_CLASSES)) {
  Object.defineProperty(warningClass.prototype, "name", { value: name, configurable: true });
}

/** The code and class of each warning the client issues itself. A `DataWarning` carries a
 *  manifest warning's code and a `SearchWarning` the code of how a reading differs, both the
 *  server's, so neither is listed. */
export const CLIENT_WARNING_CODES = {
  key_checksum_mismatch: "DfoWarning",
  key_not_base62: "DfoWarning",
  key_unknown_prefix: "DfoWarning",
  route_deprecated: "DfoDeprecationWarning",
  server_warning: "DfoWarning",
} as const satisfies Record<string, "DfoWarning" | "DfoDeprecationWarning">;

/** A code the client sets on a warning it issues itself. */
export type ClientWarningCode = keyof typeof CLIENT_WARNING_CODES;

/** Builds a warning the client issues itself, of the class `CLIENT_WARNING_CODES` gives its
 *  code. */
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

const shown = new Set<string>();

/** Emits a warning the first time its key is seen in this process. */
export function warnOnce(key: string, warning: DfoWarning, handler: WarningHandler): void {
  if (shown.has(key)) return;
  shown.add(key);
  handler(warning);
}
