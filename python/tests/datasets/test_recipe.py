"""Tests for recipes: the tree each step sends, the roots it starts from, and the
arguments it refuses before any request."""

import json
from collections.abc import Callable
from typing import Any

import pytest

from dfo._core.errors import InvalidRequestError
from dfo._core.periods import LatestYear, latest_year
from dfo._core.refs import DatasetRef, DerivedRefMember
from dfo._core.types import Rendering, Spec
from dfo._datasets.dataset import build_dataset
from dfo._datasets.recipe import Recipe, recipe
from tests._data import load
from tests._datasets import other_member, recorded_member

AID = Spec("spec_" + "a" * 32, {})
POPULATION = Spec("spec_" + "b" * 32, {})
SPEC_ROOT = {"spec_id": AID.spec_id, "rendering": {"without_party_totals": True}}
OTHER_ROOT = {
    "spec_id": POPULATION.spec_id,
    "rendering": {"without_party_totals": True},
}


def _step(chain: Recipe) -> dict[str, Any]:
    tree = chain.tree()
    assert tree["inputs"]["data"] == SPEC_ROOT
    return tree


@pytest.mark.parametrize(
    ("build", "verb", "arguments"),
    [
        (
            lambda r: r.filter(keep={"destination": ["country/KEN"], "origin": "x"}),
            "filter",
            {
                "predicates": [
                    {
                        "kind": "category_match",
                        "column": "destination",
                        "values": ["country/KEN"],
                    },
                    {"kind": "category_match", "column": "origin", "values": ["x"]},
                ]
            },
        ),
        (
            lambda r: r.aggregate(by="origin"),
            "aggregate",
            {"group_by": ["origin"], "aggregation": "sum"},
        ),
        (
            lambda r: r.aggregate(by=["origin", "destination"], how="mean"),
            "aggregate",
            {"group_by": ["origin", "destination"], "aggregation": "mean"},
        ),
        (
            lambda r: r.growth(by="origin", window=(latest_year(-4), latest_year())),
            "growth",
            {
                "window_start": {"anchor": "latest", "offset": -4},
                "window_end": {"anchor": "latest", "offset": 0},
                "entity_by": ["origin"],
                "change": "relative",
            },
        ),
        (
            lambda r: r.growth(window=(2015, 2020), change="absolute"),
            "growth",
            {
                "window_start": "2015",
                "window_end": "2020",
                "entity_by": [],
                "change": "absolute",
            },
        ),
        (
            lambda r: r.rank(by="origin"),
            "rank",
            {"rank_by": ["origin"]},
        ),
        (
            lambda r: r.rank(
                by="origin",
                window=(latest_year(), latest_year()),
                how="sum",
                limit=10,
            ),
            "rank",
            {
                "rank_by": ["origin"],
                "window_start": {"anchor": "latest", "offset": 0},
                "window_end": {"anchor": "latest", "offset": 0},
                "aggregation": "sum",
                "limit": 10,
            },
        ),
        (
            lambda r: r.share_of(by="origin"),
            "share_of",
            {"numerator_by": ["origin"]},
        ),
    ],
    ids=[
        "filter",
        "aggregate",
        "aggregate-mean",
        "growth-rolling",
        "growth-fixed",
        "rank",
        "rank-window",
        "share-of-by",
    ],
)
def test_a_one_reading_step_sends_the_engine_arguments(
    build: Callable[[Recipe], Recipe], verb: str, arguments: dict[str, Any]
) -> None:
    tree = _step(build(recipe(AID)))
    assert (tree["verb"], tree["arguments"]) == (verb, arguments)
    assert "other" not in tree["inputs"]


@pytest.mark.parametrize(
    "verb", ["quotient_of", "share_of", "join", "sum_of", "compare"]
)
@pytest.mark.parametrize(
    ("on", "sent"),
    [
        ({"destination": "place"}, {"on": {"destination": "place"}}),
        (["place"], {"on": ["place"]}),
        ("place", {"on": ["place"]}),
        (None, {}),
    ],
    ids=["mapping", "list", "one-role", "none"],
)
def test_a_two_reading_step_sends_on_and_the_other_reading(
    verb: str, on: object, sent: dict[str, Any]
) -> None:
    tree = _step(getattr(recipe(AID), verb)(POPULATION, on=on))
    assert (tree["verb"], tree["arguments"]) == (verb, sent)
    assert tree["inputs"]["other"] == OTHER_ROOT


def test_share_of_a_total_keeps_its_by_columns() -> None:
    tree = _step(recipe(AID).share_of(POPULATION, by="origin", on=["place"]))
    assert tree["arguments"] == {"numerator_by": ["origin"], "on": ["place"]}


def test_a_chain_nests_each_step_over_the_one_before() -> None:
    chain = (
        recipe(AID)
        .growth(by="origin", window=(latest_year(-4), latest_year()))
        .rank(by="origin", limit=10)
    )
    tree = chain.tree()
    assert tree["verb"] == "rank"
    assert tree["inputs"]["data"]["verb"] == "growth"
    assert tree["inputs"]["data"]["inputs"]["data"] == SPEC_ROOT
    other = recipe(POPULATION).aggregate(by="place")
    paired = recipe(AID).quotient_of(other, on={"destination": "place"}).tree()
    assert paired["inputs"]["other"] == other.tree()


def _derived_ref() -> DatasetRef:
    return DatasetRef.from_json(json.dumps(load("analysis-rank-ready.json")["ref"]))


@pytest.mark.parametrize(
    ("start", "root"),
    [
        (
            lambda: build_dataset(
                [recorded_member(rendering=Rendering("parquet", False))],
                layout="long",
                complete=True,
                missing=(),
                stale=False,
            ),
            lambda data: {
                "spec_id": data.members[0].spec.spec_id,
                "content_version": data.members[0].content_version,
                "rendering": {"without_party_totals": False},
            },
        ),
        (
            _derived_ref,
            lambda ref: {
                "spec_id": ref.members[0].spec.spec_id,
                "content_version": ref.members[0].content_version,
            },
        ),
        (
            lambda: build_dataset(
                [recorded_member(), other_member()],
                layout="long",
                complete=True,
                missing=(),
                stale=False,
            ),
            lambda data: {"ref": json.loads(data.ref.to_json())},
        ),
    ],
    ids=["dataset-version", "derived-ref", "several-members"],
)
def test_a_recipe_starts_from_what_a_dataset_or_ref_names(
    start: Callable[[], Any], root: Callable[[Any], dict[str, Any]]
) -> None:
    value = start()
    assert recipe(value).rank(by="origin").tree()["inputs"]["data"] == root(value)


def test_a_recipe_of_a_derived_ref_alone_sends_its_bare_root() -> None:
    ref = _derived_ref()
    (member,) = ref.members
    assert isinstance(member, DerivedRefMember)
    assert recipe(ref).tree() == {
        "spec_id": member.spec.spec_id,
        "content_version": member.content_version,
    }


def test_a_recipe_returns_a_recipe_given_as_it_is() -> None:
    chain = recipe(AID).rank(by="origin")
    assert recipe(chain) is chain


@pytest.mark.parametrize(
    "build",
    [
        lambda: recipe(AID).tree(),
        lambda: recipe("spec_" + "a" * 32),
        lambda: recipe(AID).filter(keep={}),
        lambda: recipe(AID).filter(keep={"origin": []}),
        lambda: recipe(AID).filter(keep={"origin": [1]}),
        lambda: recipe(AID).rank(by=[]),
        lambda: recipe(AID).rank(by="origin", limit=0),
        lambda: recipe(AID).rank(by="origin", limit=1001),
        lambda: recipe(AID).rank(by="origin", limit=True),
        lambda: recipe(AID).growth(window=(2020,)),
        lambda: recipe(AID).growth(window=(2020.0, 2024)),
        lambda: recipe(AID).growth(window=("2020", 2024)),
        lambda: recipe(AID).share_of(),
        lambda: recipe(AID).share_of(by="origin", on=["place"]),
        lambda: recipe(AID).quotient_of(POPULATION, on={}),
        lambda: recipe(AID).quotient_of("spec_b"),
        lambda: latest_year(1),
        lambda: latest_year(-10_000),
        lambda: latest_year(True),
    ],
    ids=[
        "no-step",
        "spec-id-alone",
        "keep-empty",
        "keep-no-values",
        "keep-value-not-text",
        "by-empty",
        "limit-zero",
        "limit-past-1000",
        "limit-bool",
        "window-one-year",
        "window-float",
        "window-text",
        "share-of-nothing",
        "share-of-by-with-on",
        "on-empty",
        "other-a-spec-id",
        "latest-year-ahead",
        "latest-year-too-far",
        "latest-year-bool",
    ],
)
def test_a_malformed_step_is_refused_when_it_is_added(build: Callable[[], Any]) -> None:
    with pytest.raises(InvalidRequestError) as caught:
        build()
    assert caught.value.code == "invalid_argument"


def test_latest_year_prints_the_call_that_makes_it() -> None:
    assert (repr(latest_year()), repr(latest_year(-4))) == (
        "latest_year()",
        "latest_year(-4)",
    )
    assert latest_year(-4) == LatestYear(-4)
