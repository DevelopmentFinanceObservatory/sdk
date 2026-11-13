"""The types a caller annotates with: the parts of an answer, the pieces of a
dataset and the results of `dfo.lookup`.

`dfo` itself holds `Answer`, `Dataset`, `Spec` and `DatasetRef`; this module
holds what they contain, the asynchronous `AsyncAnswer`, the `Recipe` that
`dfo.analysis.recipe` describes, `LatestYear`, what `dfo.latest_year` returns,
the `Card` a `dfo.cards` call stores, the `Share` `dfo.share` publishes and the
`Served` frames `dfo.history` lists.

It also holds the argument types the public signatures name: `Start`, `Year`,
`Columns`, `Pairing`, `Aggregation` and `GrowthChange` for `dfo.analysis`;
`Source` and `StatChange` for `dfo.cards`; and `ShareTarget` and `Moment` for
the share calls and `dfo.fetch(share, as_of=...)`. `CallTimeout` types a
call's `timeout`, and `CLIENT_TIMEOUT`, its default, stands for the client's
`timeout`, so a wrapper can pass it through.

`Severity`, `AssumptionKind`, `DepartureCode`, `NoDataReason`, `DeclinedReason`
and `ResolveKind` are the values the served contract lists for each field. A
field the client reads takes `Name | str`, since a newer server can send a value
the contract does not list yet; an option the client takes, such as `kinds`,
takes `Name`.
"""

from dfo._core.lookup_results import Catalogue, Code, Entity, Match, Node
from dfo._core.periods import LatestYear
from dfo._core.raw_response import RawResponse
from dfo._core.refs import (
    DerivedMember,
    DerivedRefMember,
    DerivedSpec,
    Groupby,
    Member,
    RefMember,
    ResolvedPeriod,
    Root,
)
from dfo._core.timeouts import CLIENT_TIMEOUT, CallTimeout
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
    Rendering,
    RequestedOperation,
    UnknownPart,
    UnsupportedPart,
    Window,
)
from dfo._datasets.build import Progress
from dfo._datasets.bundle import BundleLimits
from dfo._datasets.dataset import LeftOutSeries, LeftOutStep, PartyTotalsLeftOut
from dfo._datasets.publication import (
    Card,
    CardKind,
    Moment,
    Served,
    Share,
    ShareTarget,
    Source,
    StatChange,
)
from dfo._datasets.recipe import (
    Aggregation,
    Columns,
    GrowthChange,
    Pairing,
    Recipe,
    Start,
    Year,
)
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
    "CLIENT_TIMEOUT",
    "Aggregation",
    "Assumption",
    "AssumptionKind",
    "AsyncAnswer",
    "BundleLimits",
    "CallTimeout",
    "Candidate",
    "CandidatesPart",
    "Card",
    "CardKind",
    "Catalogue",
    "Citation",
    "CitationSource",
    "Code",
    "Columns",
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
    "Groupby",
    "GrowthChange",
    "LatestYear",
    "Layout",
    "LeftOutSeries",
    "LeftOutStep",
    "Match",
    "Member",
    "Moment",
    "NoDataPart",
    "NoDataReason",
    "Node",
    "Notice",
    "Option",
    "Pairing",
    "Part",
    "PartyTotalsLeftOut",
    "Progress",
    "RawResponse",
    "Recipe",
    "RefMember",
    "Rendering",
    "RequestedOperation",
    "ResolveKind",
    "ResolvedPeriod",
    "Root",
    "Served",
    "Severity",
    "Share",
    "ShareTarget",
    "Source",
    "Start",
    "StatChange",
    "UnknownPart",
    "UnsupportedPart",
    "Window",
    "Year",
]
