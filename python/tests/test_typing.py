"""What a type checker reads from the public surface, checked with pyright.

Each test runs pyright once over a short snippet (about two seconds) and compares
its errors with the lines the snippet marks `# error`.
"""

import json
import subprocess
import sys
import textwrap
from pathlib import Path

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
        assert isinstance(part, dfo.CandidatesPart)
        assert_type(part.candidates[0], dfo.AsyncCandidate)
        assert_type(await part.candidates[0].fetch(), dfo.Dataset)
        match answer.gaps[0].part:
            case dfo.CandidatesPart(candidates):
                assert_type(candidates, tuple[dfo.AsyncCandidate, ...])
            case dfo.DefinitePart(spec):
                assert_type(spec, dfo.Spec)
            case _:
                pass


    def sync_form(client: dfo.Client) -> None:
        answer = client.search(QUESTION)
        part = answer.parts[0]
        assert isinstance(part, dfo.CandidatesPart)
        assert_type(part.candidates[0], dfo.Candidate)
        assert_type(part.candidates[0].fetch(), dfo.Dataset)
        kind: GapKind = answer.gaps[0].kind
        missing: GapKind = part.candidates[0].fetch().missing[0].kind
        match answer.gaps[0].part:
            case dfo.CandidatesPart(candidates):
                assert_type(candidates, tuple[dfo.Candidate, ...])
            case _:
                pass


    async def awaits_the_sync_form(candidate: dfo.Candidate) -> None:
        await candidate.fetch()  # error


    def skips_await_on_the_async_form(candidate: dfo.AsyncCandidate) -> None:
        assert_type(candidate.fetch(), dfo.Dataset)  # error
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


def test_each_answer_form_fetches_a_candidate_by_its_own_call(tmp_path: Path) -> None:
    marked = [
        number
        for number, line in enumerate(CANDIDATES.splitlines(), start=1)
        if line.endswith("# error")
    ]
    assert len(marked) == 2
    assert pyright_errors(CANDIDATES, tmp_path) == marked
