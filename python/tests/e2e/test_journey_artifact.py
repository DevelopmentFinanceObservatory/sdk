"""`_artifact` from the live journey, run on the snapshot manifest `fetch-ref`
recorded. That manifest lists the fetched file under layout 5 first and under
layout 4 after it, in the plain rendering and the party-totals cut."""

import json
from collections.abc import Callable
from typing import Any

import pytest

from tests._data import CONTRACT
from tests.e2e.test_journey import _artifact


def _recorded() -> tuple[dict[str, Any], str]:
    """The recorded snapshot manifest and the digest its ref names."""
    scenario = json.loads((CONTRACT / "scenarios" / "fetch-ref.json").read_text())
    (member,) = scenario["call"][0]["ref"]["members"]
    return scenario["exchanges"][0]["response"]["json"], member["artifact"]["digest"]


def _layout_4(artifacts: list[dict[str, Any]], digest: str) -> dict[str, Any]:
    return next(
        artifact
        for artifact in artifacts
        if artifact["artifact_digest"] == digest
        and artifact["rendering"].get("layout") == 4
    )


def _layout_4_first(artifacts: list[dict[str, Any]], digest: str) -> None:
    older = _layout_4(artifacts, digest)
    artifacts.remove(older)
    artifacts.insert(0, older)


def _boolean_layout(artifacts: list[dict[str, Any]], digest: str) -> None:
    _layout_4(artifacts, digest)["rendering"]["layout"] = True


def test_the_pick_is_the_newest_layout_of_the_fetched_file() -> None:
    manifest, digest = _recorded()
    picked = _artifact(manifest, digest)
    assert (picked["artifact_digest"], picked["rendering"]["layout"]) == (digest, 5)


@pytest.mark.parametrize(
    ("edit", "failure"),
    [
        (_layout_4_first, "an older one first"),
        (_boolean_layout, "listed in two renderings"),
    ],
    ids=["older layout first", "boolean layout"],
)
def test_a_listing_the_journey_refuses(
    edit: Callable[[list[dict[str, Any]], str], None], failure: str
) -> None:
    manifest, digest = _recorded()
    edit(manifest["artifacts"], digest)
    with pytest.raises(AssertionError, match=failure):
        _artifact(manifest, digest)
