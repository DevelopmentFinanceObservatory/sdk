/**
 * The trace id an error carries: the id a user quotes to find the fault in the server's logs.
 *
 * A refusal, and an error the client raises on reading an API response, carries that response's
 * trace id: the body's `trace_id`, else the `x-dfo-trace-id` header, else null. The errors that
 * read a response are `unexpected_response`, `contract_violation`, and a strict fetch's
 * `SearchWarning` or `DataWarning`. An error about the caller's input, or about a storage-host
 * fetch, carries null.
 */
import { DfoError } from "./errors.ts";
import { isRecord } from "./json.ts";

export const TRACE_HEADER = "x-dfo-trace-id";

/** The client codes of errors that describe a response the client read. */
const RESPONSE_CODES = new Set(["unexpected_response", "contract_violation"]);

/** A response's trace id: its body's `trace_id` when the body is an object holding one, else
 *  its `x-dfo-trace-id` header, else null. */
export function traceIdOf(headers: Headers, body?: unknown): string | null {
  const found = isRecord(body) ? body["trace_id"] : undefined;
  if (typeof found === "string" && found !== "") return found;
  return headers.get(TRACE_HEADER) || null;
}

/** Gives `traceId` to an error that describes the response it names, unless the error carries
 *  one already, and returns the error. */
function traced(error: unknown, traceId: string | null): unknown {
  if (error instanceof DfoError && RESPONSE_CODES.has(error.code) && error.traceId === null) {
    // `traceId` is read-only to callers; the client settles it here, once, before it throws.
    (error as { traceId: string | null }).traceId = traceId;
  }
  return error;
}

/** Runs `read`, which reads the response whose trace id is `traceId`, and gives that id to an
 *  error it raises that describes the response. */
export function describing<T>(traceId: string | null, read: () => T): T {
  try {
    return read();
  } catch (error) {
    throw traced(error, traceId);
  }
}
