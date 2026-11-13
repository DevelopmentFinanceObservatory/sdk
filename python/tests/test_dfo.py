"""Tests for the package skeleton."""

import subprocess
import sys
from importlib.metadata import version
from types import ModuleType

import pytest

import dfo
from dfo._core.errors import DfoError, DfoWarning


def test_version_matches_the_distribution() -> None:
    """`dfo.__version__` and the `development-finance` metadata agree."""
    assert dfo.__version__ == version("development-finance")


def test_import_leaves_pyarrow_unloaded() -> None:
    """`import dfo` defers pyarrow to the first call that reads or builds a table.

    A fresh interpreter runs the import, since this process has loaded pyarrow
    through other tests.
    """
    result = subprocess.run(
        [
            sys.executable,
            "-c",
            "import sys, dfo; print('pyarrow' in sys.modules, 'dfo' in sys.modules)",
        ],
        capture_output=True,
        text=True,
        check=True,
    )
    assert result.stdout.split() == ["False", "True"]


def test_type_hints_resolve_without_pyarrow() -> None:
    """`typing.get_type_hints` reads every public class's fields, `Dataset._table`
    included, in a fresh interpreter that never loads pyarrow."""
    script = (
        "import inspect, sys, typing, dfo\n"
        "modules = (dfo, dfo.types, dfo.errors, dfo.analysis, dfo.cards, dfo.lookup, dfo.auth)\n"
        "classes = [getattr(m, n) for m in modules for n in m.__all__]\n"
        "classes = [c for c in classes if inspect.isclass(c)]\n"
        "for cls in classes:\n"
        "    typing.get_type_hints(cls)\n"
        "print(len(classes), 'pyarrow' in sys.modules)\n"
    )
    result = subprocess.run(
        [sys.executable, "-c", script], capture_output=True, text=True, check=True
    )
    count, loaded = result.stdout.split()
    assert int(count) > 40
    assert loaded == "False"


def test_the_top_level_holds_the_verbs_the_core_types_and_the_task_modules() -> None:
    public = [name for name in dir(dfo) if not name.startswith("_")]
    assert public == [
        "Answer",
        "AsyncClient",
        "Client",
        "Dataset",
        "DatasetRef",
        "Spec",
        "analysis",
        "auth",
        "cards",
        "configure",
        "errors",
        "fetch",
        "history",
        "latest_year",
        "load",
        "lookup",
        "pin",
        "search",
        "share",
        "snapshot",
        "types",
        "unshare",
    ]
    assert sorted(dfo.__all__) == sorted([*public, "__version__"])


@pytest.mark.parametrize(
    ("module", "names"),
    [
        (
            dfo.errors,
            [
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
            ],
        ),
        (
            dfo.types,
            [
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
            ],
        ),
        (
            dfo.analysis,
            [
                "aggregate",
                "compare",
                "filter",
                "growth",
                "join",
                "quotient_of",
                "rank",
                "recipe",
                "share_of",
                "sum_of",
            ],
        ),
        (dfo.cards, ["bar", "line", "source", "stat", "table"]),
        (
            dfo.lookup,
            [
                "ResolveKind",
                "catalogue",
                "code",
                "node",
                "resolve",
            ],
        ),
        (
            dfo.auth,
            [
                "ApiKey",
                "ApiKeyArgument",
                "AsyncHeaderProvider",
                "HeaderProvider",
                "login",
            ],
        ),
    ],
    ids=["errors", "types", "analysis", "cards", "lookup", "auth"],
)
def test_each_task_module_exports_its_names(
    module: ModuleType, names: list[str]
) -> None:
    assert module.__all__ == names
    assert all(hasattr(module, name) for name in names)


def test_every_error_and_warning_class_is_in_dfo_errors() -> None:
    """A class the client raises or issues cannot be left out of `dfo.errors`."""
    found: set[str] = set()
    pending: list[type] = [DfoError, DfoWarning]
    while pending:
        cls = pending.pop()
        if cls.__module__.startswith("dfo."):
            found.add(cls.__name__)
        pending.extend(cls.__subclasses__())
    assert len(found) == 21
    assert found <= set(dfo.errors.__all__)
