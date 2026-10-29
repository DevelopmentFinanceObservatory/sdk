import type { Answer, Gap } from "../search/answer.ts";
import { CODE_ACTIONS } from "../generated/actions.ts";
import type { ACTIONS } from "../generated/actions.ts";
import { CLIENT_CODE_CLASSES, CLIENT_CODE_RETRYABLE } from "../generated/client-codes.ts";
import { PROXY_CODE_STATUSES } from "../generated/proxy-codes.ts";
import type { Alternative, ProblemIssue } from "../wire.ts";
import { isRecord, objects } from "./json.ts";
import { bracketed, printable } from "./text.ts";

/** What the caller does next about a refusal, as `contract/actions.json` assigns it. */
export type Action = (typeof ACTIONS)[number];

/** The codes the client raises itself, for failures no server response describes, as
 *  `contract/client-codes.json` lists them. */
export type ClientErrorCode = keyof typeof CLIENT_CODE_CLASSES;

declare const SERVER_CODE: unique symbol;

/** A refusal code read from a server response, either one of `contract/actions.json` or any
 *  other string a newer server sends. `serverCode` is the only way to make one, so an error the
 *  client raises itself takes a `ClientErrorCode`. */
export type ServerErrorCode = string & { readonly [SERVER_CODE]: true };

/** A refusal code's shape: lower-case snake case, such as `spec_not_found`, of at most 64
 *  characters. The longest code the registry holds has 40. */
export const REFUSAL_CODE = /^[a-z][a-z0-9_]{0,63}$/;

/** The most characters of server text a refusal's message quotes; the error's `detail` and
 *  `problem` keep the whole text. The longest server detail recorded under contract/scenarios
 *  has 695 characters. */
export const MESSAGE_TEXT_MAX = 1000;

/** Server text cut to `MESSAGE_TEXT_MAX` characters, with `…` marking the cut. */
export function capped(text: string): string {
  if (text.length <= MESSAGE_TEXT_MAX) return text;
  // A cut between a surrogate pair would leave half a character.
  const cut = text.slice(0, MESSAGE_TEXT_MAX).replace(/[\ud800-\udbff]$/, "");
  return `${cut}…`;
}

/** Marks a code read from a server response. */
export const serverCode = (code: string): ServerErrorCode => code as ServerErrorCode;

/** An error's code, whether the client raised it or the server sent it. */
export type DfoErrorCode = ClientErrorCode | ServerErrorCode;

/** The brand `isDfoError` checks. `Symbol.for` returns one symbol for every copy of the package
 *  in a process, so the check holds across bundles. */
const BRAND = Symbol.for("dfo.error");

export type DfoErrorOptions = {
  code: DfoErrorCode;
  /** The HTTP status, or null when no response arrived. */
  status?: number | null;
  detail?: string;
  /** The message, when it says more than `detail`; `detail` by default. */
  message?: string;
  traceId?: string | null;
  retryable?: boolean;
  /** The wait the response's `Retry-After` header asked for, in milliseconds. */
  retryAfterMs?: number | null;
  /** The parsed problem document. */
  problem?: Readonly<Record<string, unknown>> | null;
  docsUrl?: string | null;
  /** The versions a pin call pinned before it failed. */
  pinned?: readonly string[];
  cause?: unknown;
};

/** Each error's message without the bracket the constructor adds. */
const TEXTS = new WeakMap<DfoError, string>();

/** The labels an error's bracket names: its code, then its trace id. */
const labelsOf = ({ code, traceId }: DfoError): string[] =>
  traceId === null ? [code] : [code, `trace ${traceId}`];

/** The base of every error the client raises. `code` tells the errors apart. Its message and
 *  `detail` drop the characters that steer a terminal or reorder text, since either can quote
 *  the server. The message ends with one bracket naming the code and the trace id, as in
 *  `No registry entry exists for code 'x'. [code_not_found · trace 4f2a91c0]`, on a line of its
 *  own after a message of several lines; the trace id is left out when the error has none. */
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
  /** The versions, `cv_…`, a pin call pinned before it failed, in the dataset's member order.
   *  They stay pinned. Empty for every other call. */
  readonly pinned: readonly string[];

  constructor(options: DfoErrorOptions) {
    const detail = printable(options.detail ?? options.code);
    super(
      options.message === undefined ? detail : printable(options.message),
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.code = options.code;
    this.status = options.status ?? null;
    this.detail = detail;
    this.traceId = options.traceId ?? null;
    this.retryable = options.retryable ?? false;
    this.retryAfterMs = options.retryAfterMs ?? null;
    this.problem = options.problem ?? null;
    this.docsUrl = options.docsUrl ?? null;
    this.pinned = options.pinned ?? [];
    TEXTS.set(this, this.message);
    this.message = bracketed(this.message, labelsOf(this));
  }
}

Object.defineProperty(DfoError.prototype, BRAND, { value: true });

/** An error's message without the bracket that names its code and trace id. */
export const messageOf = (error: DfoError): string => TEXTS.get(error) ?? error.message;

/** Gives `error` the trace id of the response it describes, and names it in the message. The
 *  client settles it once, before it throws. */
export function settleTraceId(error: DfoError, traceId: string | null): void {
  (error as { traceId: string | null }).traceId = traceId;
  error.message = bracketed(messageOf(error), labelsOf(error));
}

/** The options that build another error from `error`, with `error` as the cause. The message is
 *  left out, so it defaults to the detail. */
export const optionsOf = (error: DfoError): DfoErrorOptions => ({
  code: error.code,
  status: error.status,
  detail: error.detail,
  traceId: error.traceId,
  retryable: error.retryable,
  retryAfterMs: error.retryAfterMs,
  problem: error.problem,
  docsUrl: error.docsUrl,
  cause: error,
});

/** True for an error this client raised, including one from another copy of the package. */
export function isDfoError(value: unknown): value is DfoError {
  return (
    value !== null && typeof value === "object" && (value as { [BRAND]?: unknown })[BRAND] === true
  );
}

/** The request is malformed. The caller fixes it. */
export class InvalidRequestError extends DfoError {
  /** The problem document's `issues`, each naming a member of the request and what is wrong
   *  with it, such as the role a `role_incompatible` refusal could not bind. Empty when the
   *  server sent none. */
  readonly issues: readonly ProblemIssue[];
  /** The problem document's `alternatives`, the values the server offers in place of what the
   *  request named; an item without a string `ref` and `label` is left out. Empty when the
   *  server sent none. */
  readonly alternatives: readonly Alternative[];

  constructor(options: DfoErrorOptions) {
    super(options);
    this.issues = objects(options.problem?.["issues"]);
    this.alternatives = objects(options.problem?.["alternatives"]).filter(
      (item): item is Alternative =>
        typeof item["ref"] === "string" && typeof item["label"] === "string",
    );
  }
}
/** A spec, version or operation is unknown. The caller checks the id. */
export class NotFoundError extends DfoError {}
/** A part of the question has no reading. The caller chooses one or takes the answered parts. */
export class IncompleteAnswerError extends DfoError {
  /** The answer whose fetch raised it, or null for a server refusal. */
  declare readonly answer: Answer | null;
  /** The parts with no reading, each with its kind, message and options. */
  declare readonly gaps: readonly Gap[];

  constructor(options: DfoErrorOptions & { answer?: Answer; gaps?: readonly Gap[] }) {
    super(options);
    // Not enumerable, so Node prints an uncaught error's message and code and omits the whole answer.
    Object.defineProperties(this, {
      answer: { value: options.answer ?? null },
      gaps: { value: options.gaps ?? [] },
    });
  }
}
/** Search declined the question or answered with the catalogue. The caller asks a data question. */
export class DeclinedError extends DfoError {}
/** A stored version cannot be rebuilt. The caller takes the newest version. */
export class VersionUnavailableError extends DfoError {
  /** The version a fresh build in the ref's rendering returned, or else the newest plain build
   *  the server lists, which can be the ref's own, or null. A ref that left party totals out
   *  holds a cut version, which need not equal the plain build even when no newer data exists,
   *  so a differing id is no sign of newer data. `client.fetch(ref, { latest: true })` fetches the
   *  newest version in the ref's rendering. */
  readonly newestVersion: string | null;

  constructor(options: DfoErrorOptions & { newestVersion?: string | null }) {
    super(options);
    this.newestVersion = options.newestVersion ?? null;
  }
}
/** A key is missing, unknown, revoked or expired, or the credentials file is broken. */
export class AuthenticationError extends DfoError {}
/** The key lacks a scope. The caller asks for it. */
export class PermissionDeniedError extends DfoError {}
/** Over the rate limit after retries. The caller waits. */
export class RateLimitError extends DfoError {}
/** Over the build quota. The caller waits for the reset. */
export class QuotaExceededError extends DfoError {}
/** A 5xx after retries. The caller reports the trace id. */
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
/** The connection failed. The caller retries later. The platform's error is the `cause`. */
export class NetworkError extends DfoError {}
/** A deadline passed. The caller extends the timeout or resumes. */
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
  stop: PermissionDeniedError,
  wait: RateLimitError,
  wait_for_reset: QuotaExceededError,
  report: ServerError,
  upgrade: ContractError,
};

/** Statuses retried when the body does not say whether the refusal is retryable. */
const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

/** Whether a refusal whose body does not say is retryable, by its HTTP status. */
const isRetryableStatus = (status: number): boolean => RETRYABLE_STATUSES.has(status);

/** Whether a refusal is retried: as its problem document's `retryable` says, and otherwise by
 *  its status. */
export function isRetryable(status: number, body: unknown): boolean {
  if (isRecord(body) && typeof body["retryable"] === "boolean") return body["retryable"];
  return isRetryableStatus(status);
}

function classForStatus(status: number): ErrorClass {
  if (status === 401) return AuthenticationError;
  if (status === 403) return PermissionDeniedError;
  if (status === 404 || status === 410) return NotFoundError;
  if (status === 408) return DfoTimeoutError;
  if (status === 429) return RateLimitError;
  if (status >= 500) return ServerError;
  return InvalidRequestError;
}

/** The value a generated table holds for a code, or undefined for a code it lacks. */
const lookUp = <T>(table: Readonly<Record<string, T>>, code: string): T | undefined =>
  Object.hasOwn(table, code) ? table[code] : undefined;

/** The action `contract/actions.json` assigns to a code, or undefined for a code it lacks. */
export function actionFor(code: string): Action | undefined {
  return lookUp(CODE_ACTIONS, code);
}

/** A server refusal's message: its detail, cut to `MESSAGE_TEXT_MAX` characters after the
 *  client's own `lead`, if any, naming the field its problem document's `pointer` names unless
 *  the pointer is empty or the detail names it already, as in
 *  `Field required at /input/definition`. With `unmatched`, the request of a 404 with no
 *  refusal code, which matched no route, the message names that request, as in
 *  `Not found. GET https://… matched no route; check baseUrl`. The error's constructor adds the
 *  bracket that names the code. */
export function refusalMessage(
  detail: string,
  pointer: unknown,
  { lead, unmatched }: { lead?: string; unmatched?: string | undefined } = {},
): string {
  const shown = lead === undefined ? capped(detail) : `${lead}: ${capped(detail)}`;
  const at =
    typeof pointer === "string" && pointer !== "" && !detail.includes(pointer)
      ? `${shown.replace(/\.$/, "")} at ${capped(pointer)}`
      : shown;
  return unmatched === undefined
    ? at
    : `${at.replace(/\.$/, "")}. ${unmatched} matched no route; check baseUrl`;
}

/**
 * The error a 200 response's problem document stands for, or undefined when the body is none. A
 * problem document holds a string `code` and no `kind`. Its class is the one `errorClassFor`
 * gives a code the contract maps to a class. Any other code raises `contract_violation`, since a
 * 200 has no status to read a class from.
 */
export function problemAt200(body: unknown, traceId: string | null): DfoError | undefined {
  if (!isRecord(body) || typeof body["code"] !== "string" || "kind" in body) return undefined;
  const code = body["code"];
  if (actionFor(code) === undefined && proxyStatusFor(code) === undefined) {
    return clientError("contract_violation", {
      detail:
        `The response is a problem document with the code ${capped(JSON.stringify(code))}, which this ` +
        "client does not know, under HTTP 200. Upgrade the client, or report the trace id.",
      pointer: "/code",
      traceId,
    });
  }
  const detail = typeof body["detail"] === "string" ? body["detail"] : code;
  const ErrorClass = errorClassFor(code, 200);
  return new ErrorClass({
    code: serverCode(code),
    status: 200,
    detail,
    message: refusalMessage(detail, body["pointer"]),
    traceId,
    retryable: isRetryable(200, body),
    problem: body,
  });
}

/** The class for a refusal: by its code through the contract's actions, else by the status the
 *  website proxy answers its code with, else by HTTP status. */
export function errorClassFor(code: string, status: number): ErrorClass {
  const action = actionFor(code);
  if (action !== undefined) return CLASS_BY_ACTION[action];
  return classForStatus(proxyStatusFor(code) ?? status);
}

/** The status `contract/proxy-codes.json` gives a code the website proxy answers itself. */
const proxyStatusFor = (code: string): number | undefined => lookUp(PROXY_CODE_STATUSES, code);

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
