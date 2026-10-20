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

for (const [name, warningClass] of Object.entries({ DfoWarning, DfoDeprecationWarning })) {
  Object.defineProperty(warningClass.prototype, "name", { value: name, configurable: true });
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
