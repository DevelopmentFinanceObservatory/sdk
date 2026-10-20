import { CODE_ACTIONS } from "./generated/actions.ts";
import type { ACTIONS } from "./generated/actions.ts";

/** What the caller does next about a refusal, as `contract/actions.json` assigns it. */
export type Action = (typeof ACTIONS)[number];

/** A refusal code the contract knows, or any other string the server may add. */
export type DfoErrorCode = keyof typeof CODE_ACTIONS | ClientErrorCode | (string & {});

/** The codes the client raises itself, for failures no server response describes. */
export type ClientErrorCode =
  | "network_error"
  | "deadline_exceeded"
  | "contract_violation"
  | "unexpected_response"
  | "credentials_file_invalid"
  | "profile_not_found"
  | "profile_without_key";

/** The brand `isDfoError` checks. `Symbol.for` returns one symbol for every copy of the package
 *  in a process, so the check holds across bundles. */
const BRAND = Symbol.for("dfo.error");

export type DfoErrorOptions = {
  code: DfoErrorCode;
  /** The HTTP status, or null when no response arrived. */
  status?: number | null;
  detail?: string;
  traceId?: string | null;
  retryable?: boolean;
  /** The parsed problem document, or the proxy's own refusal body. */
  problem?: Readonly<Record<string, unknown>> | null;
  docsUrl?: string | null;
  cause?: unknown;
};

/** The base of every error the client raises. `code` tells the errors apart. */
export class DfoError extends Error {
  readonly code: DfoErrorCode;
  readonly status: number | null;
  readonly detail: string;
  readonly traceId: string | null;
  readonly retryable: boolean;
  readonly problem: Readonly<Record<string, unknown>> | null;
  readonly docsUrl: string | null;

  constructor(options: DfoErrorOptions) {
    const detail = options.detail ?? options.code;
    super(detail, options.cause === undefined ? undefined : { cause: options.cause });
    this.code = options.code;
    this.status = options.status ?? null;
    this.detail = detail;
    this.traceId = options.traceId ?? null;
    this.retryable = options.retryable ?? false;
    this.problem = options.problem ?? null;
    this.docsUrl = options.docsUrl ?? null;
  }
}

Object.defineProperty(DfoError.prototype, BRAND, { value: true });

/** True for an error this client raised, including one from another copy of the package. */
export function isDfoError(value: unknown): value is DfoError {
  return (
    value !== null && typeof value === "object" && (value as { [BRAND]?: unknown })[BRAND] === true
  );
}

/** The request is malformed; the caller fixes it. */
export class InvalidRequestError extends DfoError {}
/** A spec, version or operation is unknown; the caller checks the id. */
export class NotFoundError extends DfoError {}
/** A part of the question has no reading; the caller chooses one or takes the answered parts. */
export class IncompleteAnswerError extends DfoError {}
/** Search declined the question or answered with the catalogue; the caller asks a data question. */
export class DeclinedError extends DfoError {}
/** A stored version cannot be rebuilt; the caller takes the newest version. */
export class VersionUnavailableError extends DfoError {}
/** A key is missing, unknown, revoked or expired, or the credentials file is broken. */
export class AuthenticationError extends DfoError {}
/** The key lacks a scope; the caller asks for it. */
export class PermissionDeniedError extends DfoError {}
/** Over the rate limit after retries; the caller waits. */
export class RateLimitError extends DfoError {}
/** Over the build quota; the caller waits for the reset. */
export class QuotaExceededError extends DfoError {}
/** A 5xx after retries; the caller reports the trace id. */
export class ServerError extends DfoError {}
/** A field the client acts on is missing or renamed, or the server needs a newer client. */
export class ContractError extends DfoError {}
/** The connection failed; the caller retries later. The platform's error is the `cause`. */
export class NetworkError extends DfoError {}
/** A deadline passed; the caller extends the timeout or resumes. */
export class DfoTimeoutError extends DfoError {}

// Names set on each prototype from the source names, which survive minification.
for (const [name, errorClass] of Object.entries({
  DfoError,
  InvalidRequestError,
  NotFoundError,
  IncompleteAnswerError,
  DeclinedError,
  VersionUnavailableError,
  AuthenticationError,
  PermissionDeniedError,
  RateLimitError,
  QuotaExceededError,
  ServerError,
  ContractError,
  NetworkError,
  DfoTimeoutError,
})) {
  Object.defineProperty(errorClass.prototype, "name", { value: name, configurable: true });
}

type ErrorClass = new (options: DfoErrorOptions) => DfoError;

/** The class for each action. `choose` and `ask_data_question` reach the caller as gaps in an
 *  answer, which the answer raises as `IncompleteAnswerError`. */
const CLASS_BY_ACTION: Record<Action, ErrorClass> = {
  fix_request: InvalidRequestError,
  check_id: NotFoundError,
  choose: IncompleteAnswerError,
  ask_data_question: IncompleteAnswerError,
  take_newest_version: VersionUnavailableError,
  log_in: AuthenticationError,
  request_scope: PermissionDeniedError,
  wait: RateLimitError,
  wait_for_reset: QuotaExceededError,
  report: ServerError,
  upgrade: ContractError,
};

function classForStatus(status: number): ErrorClass {
  if (status === 401) return AuthenticationError;
  if (status === 403) return PermissionDeniedError;
  if (status === 404 || status === 410) return NotFoundError;
  if (status === 429) return RateLimitError;
  if (status >= 500) return ServerError;
  return InvalidRequestError;
}

/** The action `contract/actions.json` assigns to a code, or undefined for a code it lacks. */
export function actionFor(code: string): Action | undefined {
  return Object.hasOwn(CODE_ACTIONS, code)
    ? CODE_ACTIONS[code as keyof typeof CODE_ACTIONS]
    : undefined;
}

/** The class for a refusal: by its code through the contract's actions, else by HTTP status. */
export function errorClassFor(code: string, status: number): ErrorClass {
  const action = actionFor(code);
  return action === undefined ? classForStatus(status) : CLASS_BY_ACTION[action];
}
