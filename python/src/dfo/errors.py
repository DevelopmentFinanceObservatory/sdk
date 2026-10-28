"""The errors and warnings the client raises and issues.

Every refusal is a `DfoError` subclass carrying a machine-readable `code`; the
contract maps each code to one class. `BundleError` and `FormatError` report a
file or text the client cannot read. The warnings are exception classes too, so
`warnings.filterwarnings("error", category=DataWarning)` turns one into a raise.
`Alternative` and `ProblemIssue` are what an `InvalidRequestError` carries in
`alternatives` and `issues`. `ErrorCode` types an error's `code`: one of the
`ClientErrorCode` values the client raises itself, or any code a server sends.
"""

from dfo._core.errors import (
    AuthenticationError,
    ContractError,
    DataWarning,
    DeclinedError,
    DfoDeprecationWarning,
    DfoError,
    DfoTimeoutError,
    DfoWarning,
    ErrorCode,
    IncompleteAnswerError,
    InvalidRequestError,
    NetworkError,
    NotFoundError,
    PermissionDeniedError,
    QuotaExceededError,
    RateLimitError,
    SearchWarning,
    SeriesLeftOutWarning,
    ServerError,
    VersionUnavailableError,
)
from dfo._core.types import FormatError
from dfo._datasets.bundle import BundleError
from dfo._generated.error_map import ClientErrorCode
from dfo._generated.wire import Alternative, ProblemIssue

__all__ = [
    "Alternative",
    "AuthenticationError",
    "BundleError",
    "ClientErrorCode",
    "ContractError",
    "DataWarning",
    "DeclinedError",
    "DfoDeprecationWarning",
    "DfoError",
    "DfoTimeoutError",
    "DfoWarning",
    "ErrorCode",
    "FormatError",
    "IncompleteAnswerError",
    "InvalidRequestError",
    "NetworkError",
    "NotFoundError",
    "PermissionDeniedError",
    "ProblemIssue",
    "QuotaExceededError",
    "RateLimitError",
    "SearchWarning",
    "SeriesLeftOutWarning",
    "ServerError",
    "VersionUnavailableError",
]
