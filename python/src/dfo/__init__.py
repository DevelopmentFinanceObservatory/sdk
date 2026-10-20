"""Python client for the Development Finance Observatory APIs.

`dfo.search(question)` returns an `Answer` that says what DFO understood;
`answer.fetch()` or `dfo.fetch(spec_or_ref)` returns a `Dataset`. `Client` and
`AsyncClient` carry the same calls for one configuration each.
"""

from dfo._answer import AsyncAnswer
from dfo._build import Progress
from dfo._bundle import BundleError, open_bundle
from dfo._cli import login
from dfo._client import AsyncClient
from dfo._dataset import Dataset
from dfo._default import configure, fetch, search
from dfo._errors import (
    AuthenticationError,
    ContractError,
    DataWarning,
    DeclinedError,
    DfoDeprecationWarning,
    DfoError,
    DfoTimeoutError,
    DfoWarning,
    IncompleteAnswerError,
    InvalidRequestError,
    NetworkError,
    NotFoundError,
    PermissionDeniedError,
    QuotaExceededError,
    RateLimitError,
    SearchWarning,
    ServerError,
    VersionUnavailableError,
)
from dfo._keys import ApiKey
from dfo._operation import AsyncOperation
from dfo._sync._answer import Answer
from dfo._sync._client import Client
from dfo._sync._operation import Operation
from dfo._types import (
    Candidate,
    CandidatesPart,
    Citation,
    CitationSource,
    DatasetRef,
    DefinitePart,
    Departure,
    FormatError,
    Gap,
    Member,
    NoDataPart,
    Notice,
    Option,
    Part,
    RawResponse,
    RefMember,
    Rendering,
    RequestedOperation,
    Spec,
    UnknownPart,
    UnsupportedPart,
)
from dfo._version import __version__

__all__ = [
    "Answer",
    "ApiKey",
    "AsyncAnswer",
    "AsyncClient",
    "AsyncOperation",
    "AuthenticationError",
    "BundleError",
    "Candidate",
    "CandidatesPart",
    "Citation",
    "CitationSource",
    "Client",
    "ContractError",
    "DataWarning",
    "Dataset",
    "DatasetRef",
    "DeclinedError",
    "DefinitePart",
    "Departure",
    "DfoDeprecationWarning",
    "DfoError",
    "DfoTimeoutError",
    "DfoWarning",
    "FormatError",
    "Gap",
    "IncompleteAnswerError",
    "InvalidRequestError",
    "Member",
    "NetworkError",
    "NoDataPart",
    "NotFoundError",
    "Notice",
    "Operation",
    "Option",
    "Part",
    "PermissionDeniedError",
    "Progress",
    "QuotaExceededError",
    "RateLimitError",
    "RawResponse",
    "RefMember",
    "Rendering",
    "RequestedOperation",
    "SearchWarning",
    "ServerError",
    "Spec",
    "UnknownPart",
    "UnsupportedPart",
    "VersionUnavailableError",
    "__version__",
    "configure",
    "fetch",
    "login",
    "open_bundle",
    "search",
]
