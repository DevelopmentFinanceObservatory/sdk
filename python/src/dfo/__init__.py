"""Python client for the Development Finance Observatory APIs.

`dfo.search(question)` returns an `Answer` that says what DFO understood.
`answer.fetch()` or `dfo.fetch(spec_or_ref)` returns a `Dataset`. `Client` and
`AsyncClient` carry the same calls for one configuration each.
"""

from dfo._client.cli import login
from dfo._client.client import AsyncClient
from dfo._client.default import configure, disable_cache, enable_cache, fetch, search
from dfo._config.keys import ApiKey, ApiKeyArgument
from dfo._core.errors import (
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
from dfo._core.refs import DatasetRef, Member, RefMember
from dfo._core.types import (
    Assumption,
    AsyncCandidate,
    Candidate,
    CandidatesPart,
    Citation,
    CitationSource,
    DefinitePart,
    Departure,
    FormatError,
    Gap,
    Layout,
    NoDataPart,
    Node,
    Notice,
    Option,
    Part,
    RawResponse,
    Rendering,
    RequestedOperation,
    ResolveKind,
    Spec,
    UnknownPart,
    UnsupportedPart,
    Window,
)
from dfo._datasets.build import Progress
from dfo._datasets.bundle import BundleError, BundleLimits, open_bundle
from dfo._datasets.dataset import Dataset
from dfo._datasets.operation import AsyncOperation
from dfo._generated.wire import CatalogueResponse, CodeRegistryEntry, ResolveResponse
from dfo._http.hooks import AsyncHeaderProvider, HeaderProvider
from dfo._search.answer import AsyncAnswer
from dfo._search.lookups import AsyncCodes, AsyncGraph
from dfo._sync._client.client import Client
from dfo._sync._datasets.operation import Operation
from dfo._sync._search.answer import Answer
from dfo._sync._search.lookups import Codes, Graph
from dfo._version import __version__

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
