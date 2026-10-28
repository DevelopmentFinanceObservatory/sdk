"""The types a caller annotates with: the parts of an answer, the pieces of a
dataset and the results of `dfo.lookup`.

`dfo` itself holds `Answer`, `Dataset`, `Spec` and `DatasetRef`; this module
holds what they contain, the asynchronous `AsyncAnswer`, the `Recipe` that
`dfo.analysis.recipe` describes, and `LatestYear`, what `dfo.latest_year` returns.

`Severity`, `AssumptionKind`, `DepartureCode`, `NoDataReason`, `DeclinedReason`
and `ResolveKind` are the values the served contract lists for each field. A
field the client reads takes `Name | str`, since a newer server can send a value
the contract does not list yet; an option the client takes, such as `kinds`,
takes `Name`.
"""

from dfo._core.lookup_results import Catalogue, Code, Entity, Match, Node
from dfo._core.periods import LatestYear
from dfo._core.refs import (
    DerivedMember,
    DerivedRefMember,
    DerivedSpec,
    Member,
    RefMember,
    ResolvedPeriod,
    Root,
)
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
from dfo._datasets.dataset import LeftOutSeries, LeftOutStep
from dfo._datasets.recipe import Recipe
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
    "Catalogue",
    "Citation",
    "CitationSource",
    "Code",
    "DeclinedReason",
    "DefinitePart",
    "Departure",
    "DepartureCode",
    "DerivedMember",
    "DerivedRefMember",
    "DerivedSpec",
    "Entity",
    "Gap",
    "GapKind",
    "LatestYear",
    "Layout",
    "LeftOutSeries",
    "LeftOutStep",
    "Match",
    "Member",
    "NoDataPart",
    "NoDataReason",
    "Node",
    "Notice",
    "Option",
    "Part",
    "Progress",
    "RawResponse",
    "Recipe",
    "RefMember",
    "Rendering",
    "RequestedOperation",
    "ResolveKind",
    "ResolvedPeriod",
    "Root",
    "Severity",
    "UnknownPart",
    "UnsupportedPart",
    "Window",
]
