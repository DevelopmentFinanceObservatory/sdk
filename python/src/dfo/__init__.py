"""Python client for the Development Finance Observatory APIs.

`dfo.search(question)` returns an `Answer` that says what DFO understood.
`answer.fetch()` or `dfo.fetch(spec_or_ref)` returns a `Dataset`. `Client` and
`AsyncClient` carry the same calls for one configuration each.
"""

from dfo._answer import AsyncAnswer
from dfo._build import Progress
from dfo._bundle import BundleError, BundleLimits, open_bundle
from dfo._cli import login
from dfo._client import AsyncClient
from dfo._dataset import Dataset
from dfo._default import configure, disable_cache, enable_cache, fetch, search
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
from dfo._hooks import AsyncHeaderProvider, HeaderProvider
from dfo._keys import ApiKey, ApiKeyArgument
from dfo._lookups import AsyncCodes, AsyncGraph, Node, ResolveKind
from dfo._operation import AsyncOperation
from dfo._sync._answer import Answer
from dfo._sync._client import Client
from dfo._sync._lookups import Codes, Graph
from dfo._sync._operation import Operation
from dfo._types import (
    Assumption,
    AsyncCandidate,
    Candidate,
    CandidatesPart,
    Citation,
    CitationSource,
    DatasetRef,
    DefinitePart,
    Departure,
    FormatError,
    Gap,
    Layout,
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
    Window,
)
from dfo._version import __version__
from dfo._wire import CatalogueResponse, CodeRegistryEntry, ResolveResponse

__all__ = [
    "Answer",
    "ApiKey",
    "ApiKeyArgument",
    "Assumption",
    "AsyncAnswer",
    "AsyncCandidate",
    "AsyncClient",
    "AsyncCodes",
    "AsyncGraph",
    "AsyncHeaderProvider",
    "AsyncOperation",
    "AuthenticationError",
    "BundleError",
    "BundleLimits",
    "Candidate",
    "CandidatesPart",
    "CatalogueResponse",
    "Citation",
    "CitationSource",
    "Client",
    "CodeRegistryEntry",
    "Codes",
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
    "Graph",
    "HeaderProvider",
    "IncompleteAnswerError",
    "InvalidRequestError",
    "Layout",
    "Member",
    "NetworkError",
    "NoDataPart",
    "Node",
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
    "ResolveKind",
    "ResolveResponse",
    "SearchWarning",
    "ServerError",
    "Spec",
    "UnknownPart",
    "UnsupportedPart",
    "VersionUnavailableError",
    "Window",
    "__version__",
    "configure",
    "disable_cache",
    "enable_cache",
    "fetch",
    "login",
    "open_bundle",
    "search",
]
