"""Reading and writing the credentials file.

The file is the contract's TOML subset: `[profile]` tables of `name = "value"`
lines (`contract/rules/README.md`). Only the Python CLI writes it, readable by
its owner only.
"""

import os
import re
import tempfile
from pathlib import Path
from typing import Literal

type FileErrorReason = Literal[
    "outside_table", "duplicate_table", "duplicate_key", "invalid_line"
]
type Profiles = dict[str, dict[str, str]]

_NAME = r"[A-Za-z0-9_-]+"
_VALUE = r'[^"\\\x00-\x1f\x7f]*'
_TABLE = re.compile(rf"\[({_NAME})\]")
_ENTRY = re.compile(rf'({_NAME})[ \t]*=[ \t]*"({_VALUE})"')

# The format as an error names it to someone fixing the file by hand.
ACCEPTED_FORMAT = (
    'The file holds [profile] headers, name = "value" entries in double quotes, '
    "blank lines and lines that start with #. Other TOML, such as a trailing "
    "comment, a single-quoted value, a nested or dotted table or a byte order "
    "mark, is refused."
)


class CredentialsFileError(ValueError):
    """The credentials file breaks the format at one line.

    Attributes:
        reason: The contract's reason for the broken line.
        line: The 1-based number of the broken line.
    """

    def __init__(self, reason: FileErrorReason, line: int) -> None:
        super().__init__(f"line {line}: {reason}")
        self.reason: FileErrorReason = reason
        self.line = line


def parse_credentials(text: str) -> Profiles:
    """Return the profiles in a credentials file's text.

    Raises:
        CredentialsFileError: At the first line that breaks the format.
    """
    profiles: Profiles = {}
    table: dict[str, str] | None = None
    for number, raw in enumerate(text.split("\n"), start=1):
        line = raw.removesuffix("\r").strip(" \t")
        if not line or line.startswith("#"):
            continue
        if match := _TABLE.fullmatch(line):
            if match[1] in profiles:
                raise CredentialsFileError("duplicate_table", number)
            table = profiles[match[1]] = {}
        elif match := _ENTRY.fullmatch(line):
            if table is None:
                raise CredentialsFileError("outside_table", number)
            if match[1] in table:
                raise CredentialsFileError("duplicate_key", number)
            table[match[1]] = match[2]
        else:
            raise CredentialsFileError("invalid_line", number)
    return profiles


def read_profiles(path: str | os.PathLike[str]) -> Profiles | None:
    """Return the profiles in the file at `path`, or None when there is none.

    Raises:
        CredentialsFileError: The file breaks the format. A file that is not
            UTF-8 counts as broken at line 1.
    """
    try:
        data = Path(path).read_bytes()
    except FileNotFoundError:
        return None
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError as error:
        raise CredentialsFileError("invalid_line", 1) from error
    return parse_credentials(text)


def render_credentials(profiles: Profiles) -> str:
    """Return the file text for `profiles`.

    Raises:
        ValueError: A profile or entry name, or a value, that the format cannot hold.
    """
    tables = []
    for profile, entries in profiles.items():
        if not re.fullmatch(_NAME, profile):
            raise ValueError(
                f"A profile name holds only A-Z, a-z, 0-9, _ and -: {profile!r}"
            )
        lines = [f"[{profile}]"]
        for name, value in entries.items():
            if not re.fullmatch(_NAME, name):
                raise ValueError(
                    f"An entry name holds only A-Z, a-z, 0-9, _ and -: {name!r}"
                )
            if not re.fullmatch(_VALUE, value):
                raise ValueError(
                    f"The value of {name!r} holds a quote, a backslash or a control "
                    "character, which the credentials file cannot store"
                )
            lines.append(f'{name} = "{value}"')
        tables.append("\n".join(lines) + "\n")
    return "\n".join(tables)


def store_key(path: str | os.PathLike[str], profile: str, key: str) -> None:
    """Set `profile`'s key in the file at `path`, keeping every other entry.

    The file is written to a temporary name created owner-only, then renamed
    into place, so a reader never sees a partial file. The directory is created
    owner-only when missing.

    Raises:
        CredentialsFileError: The existing file breaks the format.
        ValueError: The profile name or key cannot be stored.
    """
    target = Path(path)
    profiles = read_profiles(target) or {}
    profiles.setdefault(profile, {})["key"] = key
    text = render_credentials(profiles)
    target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(
        dir=target.parent, prefix=".credentials-", suffix=".tmp"
    )
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as file:
            file.write(text)
        os.replace(temporary, target)
    except BaseException:
        Path(temporary).unlink(missing_ok=True)
        raise
