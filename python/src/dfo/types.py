"""The types a caller annotates with: the parts of an answer and the pieces of
a dataset.

`dfo` itself holds `Answer`, `Dataset`, `Spec` and `DatasetRef`; this module
holds what they contain, and the asynchronous `AsyncAnswer`.

`Severity`, `AssumptionKind`, `DepartureCode`, `NoDataReason`, `DeclinedReason`
and `ResolveKind` are the values the served contract lists for each field. A
field the client reads takes `Name | str`, since a newer server can send a value
the contract does not list yet; an option the client takes, such as `kinds`,
takes `Name`.
"""

from dfo._core.refs import Member, RefMember
from dfo._core.types import (
    Assumption,
    Candidate,
    CandidatesPart,
    Citation,
    CitationSource,
    DefinitePart,
    Departure,
    Gap,
    GapKind,
    Layout,
    NoDataPart,
    Notice,
    Option,
    Part,
    RawResponse,
    Rendering,
    RequestedOperation,
    UnknownPart,
    UnsupportedPart,
    Window,
)
from dfo._datasets.build import Progress
from dfo._datasets.bundle import BundleLimits
from dfo._generated.wire import (
    AssumptionKind,
    DeclinedReason,
    DepartureCode,
    NoDataReason,
    ResolveKind,
    Severity,
)
from dfo._search.answer import AsyncAnswer

__all__ = [
    "Assumption",
    "AssumptionKind",
    "AsyncAnswer",
    "BundleLimits",
    "Candidate",
    "CandidatesPart",
    "Citation",
    "CitationSource",
    "DeclinedReason",
    "DefinitePart",
    "Departure",
    "DepartureCode",
    "Gap",
    "GapKind",
    "Layout",
    "Member",
    "NoDataPart",
    "NoDataReason",
    "Notice",
    "Option",
    "Part",
    "Progress",
    "RawResponse",
    "RefMember",
    "Rendering",
    "RequestedOperation",
    "ResolveKind",
    "Severity",
    "UnknownPart",
    "UnsupportedPart",
    "Window",
]
