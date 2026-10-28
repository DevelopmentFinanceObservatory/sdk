export { Answer, SearchWarning } from "./search/answer.ts";
export type {
  AnswerDiagnostics,
  AnswerFetchOptions,
  AnswerKind,
  AnswerStatus,
  Candidate,
  ChooseOptions,
  Gap,
  GapKind,
  QueryOption,
  SearchOptions,
} from "./search/answer.ts";
export type { AnswerJson } from "./search/answer-json.ts";
export type { ChoiceKey } from "./search/choices.ts";
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
export type {
  Alternative,
  Assumption,
  AssumptionKind,
  CandidatesPart,
  CatalogueResponse,
  CitationSource,
  CodeRegistryEntry,
  DeclinedReason,
  DefinitePart,
  Departure,
  DepartureCode,
  Diagnostics,
  EntityGroup,
  EntityRef,
  KnownPart,
  NoDataPart,
  NoDataReason,
  Notice,
  ParsedInput,
  Part,
  ProblemIssue,
  RequestedOperation,
  ResolvedSpec,
  ResolveKind,
  ResolveResponse,
  ResolveResult,
  Severity,
  UnknownPart,
  UnsupportedPart,
} from "./wire.ts";
export { Dataset } from "./datasets/dataset.ts";
export type { Citation, DerivedMember, Member } from "./datasets/dataset.ts";
export type {
  CallOptions,
  EntityGroups,
  FetchOptions,
  MemberRequest,
  Narrowing,
  Window,
} from "./datasets/fetch.ts";
export { ApiKey } from "./config/keys.ts";
export type { ApiKeyOption } from "./config/keys.ts";
export { Lookup } from "./search/lookups.ts";
export type {
  CatalogueOptions,
  LookupOptions,
  NodeOptions,
  ResolveOptions,
} from "./search/lookups.ts";
export { Catalogue, Code, Entity, Match, Node } from "./search/lookup-results.ts";
export type { GraphNode } from "./search/lookup-results.ts";
export type { Progress, ProgressEvent, ProgressHandler } from "./datasets/operation.ts";
export type { Row, Value } from "./datasets/parquet.ts";
export { isKnownPart, PART_STATUSES } from "./core/parts.ts";
export { specRoles } from "./core/roles.ts";
export { DatasetRef, FormatError } from "./core/ref.ts";
export type {
  DatasetRefJson,
  DerivedRefMember,
  DerivedSpec,
  FormatErrorReason,
  Layout,
  RefMember,
  Rendering,
  ResolvedPeriod,
  Root,
  Spec,
} from "./core/ref.ts";
export { RawResponse } from "./http/transport.ts";
export type { HeaderProvider } from "./http/transport.ts";
export { VERSION } from "./version.ts";
export { DataWarning, DfoDeprecationWarning, DfoWarning } from "./core/warnings.ts";
export type { WarningHandler } from "./core/warnings.ts";
