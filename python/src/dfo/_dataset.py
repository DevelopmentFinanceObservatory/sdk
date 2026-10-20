"""Stand-in for the dataset module, holding only the interface a fetch calls.

The real module replaces this file when the branches merge: it defines
`FetchedMember`, `Dataset` and `build_dataset` with these names and signatures.
"""

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

from dfo._build import Layout
from dfo._types import Gap, Spec


@dataclass(frozen=True, slots=True)
class FetchedMember:
    """One built and downloaded reading, as a fetch hands it to `build_dataset`.

    Attributes:
        parts: The variable text of each answer part the member answers.
        spec: The built reading, with its sentence.
        sentence: Search's sentence for the built reading.
        content_version: The version's id.
        manifest: The server's manifest for the version, decoded and untouched.
        digest: The digest the Parquet bytes were checked against.
        data: The Parquet bytes.
    """

    parts: tuple[str, ...]
    spec: Spec
    sentence: str
    content_version: str
    manifest: Mapping[str, Any] = field(repr=False)
    digest: str
    data: bytes = field(repr=False)


class Dataset:
    """Stand-in for the dataset class."""


def build_dataset(
    members: Sequence[FetchedMember],
    *,
    layout: Layout,
    complete: bool,
    missing: Sequence[Gap],
    stale: bool,
) -> Dataset:
    """Stand-in for the dataset builder."""
    raise NotImplementedError
