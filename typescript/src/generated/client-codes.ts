// Generated from contract/client-codes.json by `pnpm generate`. Do not edit by hand.

export const CLIENT_CODE_CLASSES = {
  answer_declined: "DeclinedError",
  answer_incomplete: "IncompleteAnswerError",
  choice_invalid: "InvalidRequestError",
  contract_violation: "ContractError",
  credentials_file_invalid: "AuthenticationError",
  deadline_exceeded: "DfoTimeoutError",
  digest_mismatch: "ServerError",
  download_failed: "ServerError",
  invalid_argument: "InvalidRequestError",
  network_error: "NetworkError",
  offline: "NetworkError",
  profile_not_found: "AuthenticationError",
  profile_without_key: "AuthenticationError",
  refusal_without_code: "by_status",
  unexpected_response: "ContractError",
  version_unavailable: "VersionUnavailableError",
} as const;
