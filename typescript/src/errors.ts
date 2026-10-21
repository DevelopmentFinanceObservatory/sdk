import type { Answer, Gap } from "./answer.ts";
import { CODE_ACTIONS } from "./generated/actions.ts";
import type { ACTIONS } from "./generated/actions.ts";
import { CLIENT_CODE_CLASSES, CLIENT_CODE_RETRYABLE } from "./generated/client-codes.ts";

/** What the caller does next about a refusal, as `contract/actions.json` assigns it. */
export type Action = (typeof ACTIONS)[number];

/** The codes the client raises itself, for failures no server response describes, as
 *  `contract/client-codes.json` lists them. */
export type ClientErrorCode = keyof typeof CLIENT_CODE_CLASSES;

declare const SERVER_CODE: unique symbol;

/** A refusal code read from a server response: one of `contract/actions.json`, or any other
 *  string a newer server sends. `serverCode` is the only way to make one, so an error the
 *  client raises itself takes a `ClientErrorCode`. */
export type ServerErrorCode = string & { readonly [SERVER_CODE]: true };

/** Marks a code read from a server response. */
export const serverCode = (code: string): ServerErrorCode => code as ServerErrorCode;

/** An error's code: one the client raises, or one the server sent. */
export type DfoErrorCode = ClientErrorCode | ServerErrorCode;

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
  /** The wait the response's `Retry-After` header asked for, in milliseconds. */
  retryAfterMs?: number | null;
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
  /** The wait the response's `Retry-After` header asked for, in milliseconds, or null. */
  readonly retryAfterMs: number | null;
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
    this.retryAfterMs = options.retryAfterMs ?? null;
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
export class IncompleteAnswerError extends DfoError {
  /** The answer whose fetch raised it, or null for a server refusal. */
  readonly answer: Answer | null;
  /** The parts with no reading, each with its kind, message and options. */
  readonly gaps: readonly Gap[];

  constructor(options: DfoErrorOptions & { answer?: Answer; gaps?: readonly Gap[] }) {
    super(options);
    this.answer = options.answer ?? null;
    this.gaps = options.gaps ?? [];
  }
}
/** Search declined the question or answered with the catalogue; the caller asks a data question. */
export class DeclinedError extends DfoError {}
/** A stored version cannot be rebuilt; the caller takes the newest version. */
export class VersionUnavailableError extends DfoError {
  /** The newest version the lookup found, which fetching the spec returns, or null. */
  readonly newestVersion: string | null;

  constructor(options: DfoErrorOptions & { newestVersion?: string | null }) {
    super(options);
    this.newestVersion = options.newestVersion ?? null;
  }
}
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
export class ContractError extends DfoError {
  /** The JSON Pointer to the member a response lacks, or null when no one member is at fault. */
  readonly pointer: string | null;

  constructor(options: DfoErrorOptions & { pointer?: string }) {
    super(options);
    this.pointer = options.pointer ?? null;
  }
}
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

/** Statuses retried when the body does not say whether the refusal is retryable. */
const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

/** Whether a refusal whose body does not say is retryable, by its HTTP status. */
export const isRetryableStatus = (status: number): boolean => RETRYABLE_STATUSES.has(status);

function classForStatus(status: number): ErrorClass {
  if (status === 401) return AuthenticationError;
  if (status === 403) return PermissionDeniedError;
  if (status === 404 || status === 410) return NotFoundError;
  if (status === 408) return DfoTimeoutError;
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

type ClientClassName = Exclude<(typeof CLIENT_CODE_CLASSES)[ClientErrorCode], "by_status">;

/** The class for each class name `contract/client-codes.json` uses. */
const CLIENT_CLASSES = {
  AuthenticationError,
  ContractError,
  DeclinedError,
  DfoTimeoutError,
  IncompleteAnswerError,
  InvalidRequestError,
  NetworkError,
  ServerError,
  VersionUnavailableError,
} satisfies Record<ClientClassName, ErrorClass>;

type ClientClass<C extends ClientErrorCode> = (typeof CLIENT_CLASSES)[Exclude<
  (typeof CLIENT_CODE_CLASSES)[C],
  "by_status"
>];

/** The options an error with a client code takes: its class's options without the code and
 *  the retryable flag, which the code's row gives, and a status for a code whose class and flag
 *  the status picks. Such a code takes a retryable flag the response states over its status's. */
export type ClientErrorOptions<C extends ClientErrorCode> =
  (typeof CLIENT_CODE_CLASSES)[C] extends "by_status"
    ? Omit<DfoErrorOptions, "code" | "status" | "retryable"> & {
        status: number;
        retryable?: boolean;
      }
    : Omit<ConstructorParameters<ClientClass<C>>[0], "code" | "retryable">;

/** The error a client code raises. */
export type ClientError<C extends ClientErrorCode> =
  (typeof CLIENT_CODE_CLASSES)[C] extends "by_status" ? DfoError : InstanceType<ClientClass<C>>;

/** Builds an error the client raises itself, of the class and retryable flag
 *  `contract/client-codes.json` assigns to its code, or for `refusal_without_code` the class
 *  its status maps to, and the flag the body states or else its status maps to. */
export function clientError<C extends ClientErrorCode>(
  code: C,
  options: ClientErrorOptions<C>,
): ClientError<C> {
  const name: ClientClassName | "by_status" = CLIENT_CODE_CLASSES[code];
  const flag: boolean | "by_status" = CLIENT_CODE_RETRYABLE[code];
  const built = { ...options, code } as DfoErrorOptions;
  const status = built.status ?? 0;
  const ErrorClass = name === "by_status" ? classForStatus(status) : CLIENT_CLASSES[name];
  const retryable = flag === "by_status" ? (built.retryable ?? isRetryableStatus(status)) : flag;
  return new ErrorClass({ ...built, retryable }) as ClientError<C>;
}
