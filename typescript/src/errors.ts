/**
 * The `@developmentfinance/client/errors` entry point: every error a call throws, each a
 * `DfoError`, the warnings a call reports, and the types their fields carry. It holds what
 * Python's `dfo.errors` holds.
 */
export {
  AuthenticationError,
  ContractError,
  DeclinedError,
  DfoError,
  DfoTimeoutError,
  IncompleteAnswerError,
  InvalidRequestError,
  isDfoError,
  NetworkError,
  NotFoundError,
  PermissionDeniedError,
  QuotaExceededError,
  RateLimitError,
  ServerError,
  VersionUnavailableError,
} from "./core/errors.ts";
export type {
  Action,
  ClientErrorCode,
  DfoErrorCode,
  DfoErrorOptions,
  ServerErrorCode,
} from "./core/errors.ts";
export { FormatError } from "./core/ref.ts";
export type { FormatErrorReason } from "./core/ref.ts";
export { SearchWarning } from "./search/answer.ts";
export {
  DataWarning,
  DfoDeprecationWarning,
  DfoWarning,
  SeriesLeftOutWarning,
} from "./core/warnings.ts";
export type { WarningHandler } from "./core/warnings.ts";
export type { Alternative, ProblemIssue } from "./wire.ts";
