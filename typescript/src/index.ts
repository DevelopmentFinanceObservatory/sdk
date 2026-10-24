export { Answer, Candidate, SearchWarning } from "./search/answer.ts";
export type {
  AnswerDiagnostics,
  AnswerFetchOptions,
  AnswerKind,
  AnswerStatus,
  Gap,
  GapKind,
  QueryOption,
  SearchOptions,
} from "./search/answer.ts";
export { Client } from "./client.ts";
export type { ClientOptions, RawRequestOptions } from "./client.ts";
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
export type { Alternative, ProblemIssue } from "./wire.ts";
export { Dataset } from "./datasets/dataset.ts";
export type { Citation, Member } from "./datasets/dataset.ts";
export type {
  EntityGroups,
  FetchOptions,
  MemberRequest,
  MintOptions,
  Narrowing,
  ResumeOptions,
  SpecInput,
  Window,
} from "./datasets/fetch.ts";
export { ApiKey, checkKeyFormat, resolveApiKey } from "./config/keys.ts";
export type {
  ApiKeyOption,
  KeyFormatReason,
  KeyFormatVerdict,
  KeySource,
  ResolvedKey,
} from "./config/keys.ts";
export { Codes, Graph } from "./search/lookups.ts";
export type {
  CatalogueOptions,
  GraphNode,
  LookupOptions,
  NodeOptions,
  ResolveKind,
  ResolveOptions,
} from "./search/lookups.ts";
export { Operation } from "./datasets/operation.ts";
export type {
  Progress,
  ProgressEvent,
  ProgressHandler,
  ResultOptions,
} from "./datasets/operation.ts";
export type { Row, Value } from "./datasets/parquet.ts";
export { isKnownPart, PART_STATUSES } from "./core/parts.ts";
export { DatasetRef, FormatError } from "./core/ref.ts";
export type {
  DatasetRefJson,
  FormatErrorReason,
  Layout,
  RefMember,
  Rendering,
  SpecLike,
} from "./core/ref.ts";
export { RawResponse } from "./http/transport.ts";
export type { HeaderProvider } from "./http/transport.ts";
export { VERSION } from "./version.ts";
export { DataWarning, DfoDeprecationWarning, DfoWarning } from "./core/warnings.ts";
export type { WarningHandler } from "./core/warnings.ts";
