"""What a type checker reads from the public surface, checked with pyright and ty.

Each case runs pyright once over a short snippet (about two seconds) and compares
its errors with the lines the snippet marks `# error`.
"""

import json
import subprocess
import sys
import textwrap
from pathlib import Path

import pytest

CANDIDATES = textwrap.dedent(
    """
    from typing import Literal, assert_type

    import dfo

    GapKind = Literal[
        "choice", "no_data", "not_understood", "unsupported", "timed_out", "unknown"
    ]

    QUESTION = "GNI of Germany from 2015 to 2022"


    async def async_form(client: dfo.AsyncClient) -> None:
        answer = await client.search(QUESTION)
        part = answer.parts[0]
        assert isinstance(part, dfo.types.CandidatesPart)
        assert_type(part.candidates[0], dfo.types.Candidate)
        chosen = await answer.choose(0, part="GNI")
        assert_type(chosen, dfo.types.AsyncAnswer)
        revived = dfo.types.AsyncAnswer.from_json(answer.to_json(), client=client)
        assert_type(revived, dfo.types.AsyncAnswer)
        match answer.gaps[0].part:
            case dfo.types.CandidatesPart(candidates):
                assert_type(candidates, tuple[dfo.types.Candidate, ...])
            case dfo.types.DefinitePart(spec):
                assert_type(spec, dfo.Spec)
            case _:
                pass


    def sync_form(client: dfo.Client) -> None:
        answer = client.search(QUESTION)
        assert_type(answer.choose("Congo [DRC]"), dfo.Answer)
        assert_type(dfo.Answer.from_json(answer.to_json()), dfo.Answer)
        assert_type(dfo.Answer.from_json(answer.to_json(), client=client), dfo.Answer)
        kind: GapKind = answer.gaps[0].kind
        exported: dfo.types.GapKind = kind


    def remedies(error: dfo.errors.InvalidRequestError) -> None:
        assert_type(error.issues, tuple[dfo.errors.ProblemIssue, ...])
        assert_type(error.alternatives, tuple[dfo.errors.Alternative, ...])


    def names_the_part_by_keyword(answer: dfo.Answer) -> None:
        answer.choose(0, 0)  # error


    def a_candidate_does_not_fetch(candidate: dfo.types.Candidate) -> None:
        candidate.fetch()  # error


    def an_async_answer_names_its_client(text: str) -> None:
        dfo.types.AsyncAnswer.from_json(text)  # error
    """
)

# A value the client reads is open, since a newer server can send one the contract
# does not list; a value the caller passes is closed.
CHOICES = textwrap.dedent(
    """
    import dfo
    from dfo.types import Assumption, Departure, Notice


    def reads_values_the_contract_does_not_list(spec: dfo.Spec) -> None:
        notice = Notice(code="x", severity="brand_new", message="m")
        shown: str = notice.severity
        Assumption(kind="brand_new", binding_ref="how:x", text="t")
        Departure(code="brand_new", text="t")
        server: dfo.errors.ErrorCode = "brand_new_refusal"
        raised: dfo.errors.ClientErrorCode = "refusal_without_code"
        dfo.fetch(spec, entities={"recipient": ["country/NGA"], "donor": None})
        dfo.lookup.resolve("Nigeria", kinds=["country", "code"])


    def passes_only_listed_values(spec: dfo.Spec) -> None:
        dfo.lookup.resolve("Nigeria", kinds=["countries"])  # error
        dfo.fetch(spec, entities={"recipient": "country/NGA"})  # error
        severity: dfo.types.Severity = "loud"  # error
        reason: dfo.types.DeclinedReason = "rude"  # error
        code: dfo.errors.ClientErrorCode = "brand_new_refusal"  # error


    def chooses_live_or_fixed_out_loud(data: dfo.Dataset) -> None:
        card = dfo.cards.stat(data, change="percent")
        kind: dfo.types.CardKind = card.kind
        dfo.share(card, latest=True)
        dfo.share(card)  # error
        dfo.cards.stat(data, change="percent_change")  # error
        dfo.analysis.growth(data, window=(2020, 2024), change="relative")
        dfo.analysis.growth(data, window=(2020, 2024), change="percent")  # error
        dfo.cards.stat(data, change="relative")  # error
    """
)


# Each fetch target takes only the options that apply to it.
FETCH_TARGETS = textwrap.dedent(
    """
    import dfo
    from dfo.types import Recipe, Share

    SHARE_URL = "https://developmentfinance.org/s/k3Qx8vTa"


    def takes_what_each_target_takes(
        spec: dfo.Spec,
        ref: dfo.DatasetRef,
        recipe: Recipe,
        share: Share,
        either: dfo.Spec | dfo.DatasetRef,
        client: dfo.Client,
    ) -> None:
        nigeria = dfo.lookup.resolve("Nigeria")
        dfo.fetch(spec, window="latest", entities={"recipient": nigeria})
        dfo.fetch(spec, entities={"recipient": ["country/KEN", nigeria[0]]})
        dfo.fetch(spec, layout="frame", party_totals=True, timeout=None)
        dfo.fetch(ref, latest=True, progress=False, timeout=30)
        dfo.fetch(recipe, latest=True, strict=True)
        dfo.fetch(share, slot=1, as_of="2026-10-28")
        dfo.fetch(SHARE_URL, slot=1)
        dfo.fetch(either, strict=True)
        client.fetch(spec, facets={"unit": None})


    def refuses_what_a_target_ignores(
        spec: dfo.Spec, ref: dfo.DatasetRef, recipe: Recipe, share: Share
    ) -> None:
        dfo.fetch(spec, latest=True)  # error
        dfo.fetch(spec, slot=1)  # error
        dfo.fetch(ref, window="latest")  # error
        dfo.fetch(ref, entities={"recipient": ["country/NGA"]})  # error
        dfo.fetch(ref, layout="frame")  # error
        dfo.fetch(recipe, progress=False)  # error
        dfo.fetch(recipe, party_totals=True)  # error
        dfo.fetch(share, latest=True)  # error
        dfo.fetch(SHARE_URL, facets={})  # error


    def the_client_forms_refuse_too(
        client: dfo.Client, ref: dfo.DatasetRef, spec: dfo.Spec
    ) -> None:
        client.fetch(ref, party_totals=True)  # error
        client.fetch(spec, as_of="2026-10-28")  # error


    async def the_async_client_refuses_too(
        client: dfo.AsyncClient, ref: dfo.DatasetRef
    ) -> None:
        await client.fetch(ref, window="all")  # error
    """
)

# A wrapper forwards a target of any kind with the options every target takes. ty
# matches a target typed by a bound type variable only through the overload that
# takes the whole union.
FORWARDED_TARGETS = textwrap.dedent(
    """
    import dfo
    from dfo.types import CLIENT_TIMEOUT, CallTimeout, Recipe, ShareTarget


    def forwards[T: dfo.Spec | dfo.DatasetRef | Recipe | ShareTarget](
        target: T, client: dfo.Client, timeout: CallTimeout = CLIENT_TIMEOUT
    ) -> dfo.Dataset:
        dfo.fetch(target, strict=True, timeout=timeout)
        return client.fetch(target, strict=True, timeout=timeout)


    async def forwards_async(
        target: dfo.Spec | dfo.DatasetRef, client: dfo.AsyncClient
    ) -> dfo.Dataset:
        return await client.fetch(target, strict=True, timeout=CLIENT_TIMEOUT)
    """
)


def pyright_errors(source: str, directory: Path) -> list[int]:
    """The 1-based lines pyright reports at least one error on."""
    path = directory / "snippet.py"
    path.write_text(source, encoding="utf-8")
    result = subprocess.run(
        [
            sys.executable,
            "-m",
            "pyright",
            "--outputjson",
            "--pythonpath",
            sys.executable,
            str(path),
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    report = json.loads(result.stdout)
    return sorted(
        {
            diagnostic["range"]["start"]["line"] + 1
            for diagnostic in report["generalDiagnostics"]
            if diagnostic["severity"] == "error"
        }
    )


@pytest.mark.parametrize(
    ("source", "count"),
    [(CANDIDATES, 3), (CHOICES, 9), (FETCH_TARGETS, 12), (FORWARDED_TARGETS, 0)],
    ids=[
        "answer-forms",
        "closed-inputs-open-outputs",
        "fetch-targets",
        "forwarded-targets",
    ],
)
def test_pyright_reports_exactly_the_marked_lines(
    source: str, count: int, tmp_path: Path
) -> None:
    marked = [
        number
        for number, line in enumerate(source.splitlines(), start=1)
        if line.endswith("# error")
    ]
    assert len(marked) == count
    assert pyright_errors(source, tmp_path) == marked


def test_ty_reads_a_forwarded_target(tmp_path: Path) -> None:
    path = tmp_path / "snippet.py"
    path.write_text(FORWARDED_TARGETS, encoding="utf-8")
    result = subprocess.run(
        [sys.executable, "-m", "ty", "check", "--python", sys.executable, str(path)],
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stdout
