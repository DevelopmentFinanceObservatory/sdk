"""The codes the client raises errors and issues warnings with.

Each constant pairs a row of `dfo._generated.error_map` with the class the row
names. The class is written here so the type checker knows what `client_error`
and `client_warning` return. The retryable flag comes from the row.
`tests/core/test_errors.py` fails when a constant's class differs from its row's,
or when a row has no constant.
"""

from typing import Final

from dfo._core.errors import (
    AuthenticationError,
    ClientCode,
    ContractError,
    DeclinedError,
    DfoDeprecationWarning,
    DfoError,
    DfoTimeoutError,
    DfoWarning,
    IncompleteAnswerError,
    InvalidRequestError,
    NetworkError,
    SeriesLeftOutWarning,
    ServerError,
    VersionUnavailableError,
    WarningCode,
)
from dfo._generated.error_map import CLIENT_CODES, ClientCodeName, WarningCodeName


def _client[E: DfoError](code: ClientCodeName, error_class: type[E]) -> ClientCode[E]:
    """The client code `code`, raised as `error_class` with its row's flag."""
    _, retryable = CLIENT_CODES[code]
    return ClientCode(code, error_class, retryable)


def _warning[W: DfoWarning](
    code: WarningCodeName, warning_class: type[W]
) -> WarningCode[W]:
    """The warning code `code`, issued as `warning_class`."""
    return WarningCode(code, warning_class)


ANSWER_DECLINED: Final = _client("answer_declined", DeclinedError)
ANSWER_INCOMPLETE: Final = _client("answer_incomplete", IncompleteAnswerError)
BASE_URL_INVALID: Final = _client("base_url_invalid", InvalidRequestError)
CHOICE_INVALID: Final = _client("choice_invalid", InvalidRequestError)
CONTRACT_VIOLATION: Final = _client("contract_violation", ContractError)
CREDENTIALS_FILE_INVALID: Final = _client(
    "credentials_file_invalid", AuthenticationError
)
CREDENTIALS_FILE_UNREADABLE: Final = _client(
    "credentials_file_unreadable", AuthenticationError
)
DEADLINE_EXCEEDED: Final = _client("deadline_exceeded", DfoTimeoutError)
DIGEST_MISMATCH: Final = _client("digest_mismatch", ServerError)
DOWNLOAD_FAILED: Final = _client("download_failed", ServerError)
HEADER_INVALID: Final = _client("header_invalid", InvalidRequestError)
INSECURE_TRANSPORT: Final = _client("insecure_transport", InvalidRequestError)
INVALID_ARGUMENT: Final = _client("invalid_argument", InvalidRequestError)
KEY_EMPTY: Final = _client("key_empty", AuthenticationError)
KEY_INVALID: Final = _client("key_invalid", AuthenticationError)
NETWORK_ERROR: Final = _client("network_error", NetworkError)
OFFLINE: Final = _client("offline", NetworkError)
PROFILE_NOT_FOUND: Final = _client("profile_not_found", AuthenticationError)
PROFILE_WITHOUT_KEY: Final = _client("profile_without_key", AuthenticationError)
RESPONSE_TOO_LARGE: Final = _client("response_too_large", ServerError)
UNEXPECTED_RESPONSE: Final = _client("unexpected_response", ContractError)
VERSION_UNAVAILABLE: Final = _client("version_unavailable", VersionUnavailableError)

KEY_CHECKSUM_MISMATCH: Final = _warning("key_checksum_mismatch", DfoWarning)
KEY_NOT_BASE62: Final = _warning("key_not_base62", DfoWarning)
KEY_UNKNOWN_PREFIX: Final = _warning("key_unknown_prefix", DfoWarning)
REF_DIGEST_CHANGED: Final = _warning("ref_digest_changed", DfoWarning)
ROUTE_DEPRECATED: Final = _warning("route_deprecated", DfoDeprecationWarning)
SERIES_LEFT_OUT: Final = _warning("series_left_out", SeriesLeftOutWarning)
SERVER_WARNING: Final = _warning("server_warning", DfoWarning)
