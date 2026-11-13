"""The masked API key type, the key format check and the key lookup order.

The format and the lookup order are the contract's (`contract/rules/README.md`).
"""

import hmac
import importlib
import os
import string
import sys
import zlib
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Literal, NoReturn, Self

from dfo._config.credentials import (
    ACCEPTED_FORMAT,
    CredentialsFileError,
    read_profiles,
)
from dfo._config.paths import credentials_path
from dfo._core.codes import (
    CREDENTIALS_FILE_INVALID,
    CREDENTIALS_FILE_UNREADABLE,
    KEY_CHECKSUM_MISMATCH,
    KEY_EMPTY,
    KEY_INVALID,
    KEY_NOT_BASE62,
    KEY_UNKNOWN_PREFIX,
    PROFILE_NOT_FOUND,
    PROFILE_WITHOUT_KEY,
)
from dfo._core.errors import (
    DfoWarning,
    WarningCode,
    client_error,
    client_warning,
    warn_once,
)
from dfo._core.text import key_fault

type KeyFormatProblem = Literal["unknown_prefix", "not_base62", "checksum_mismatch"]
type KeySource = Literal[
    "argument", "environment", "credentials_file", "colab", "anonymous"
]

_BASE62 = string.digits + string.ascii_uppercase + string.ascii_lowercase
_PREFIXES = ("dfo_k_", "dfo_p_")
_PREFIX_LENGTH = 6
_CHECKSUM_LENGTH = 6
_SHOWN_TAIL = 4
_COLAB_SECRET = "DFO_API_KEY"

# The warning each way a key breaks the format issues.
_FORMAT_WARNINGS: dict[KeyFormatProblem, WarningCode[DfoWarning]] = {
    "unknown_prefix": KEY_UNKNOWN_PREFIX,
    "not_base62": KEY_NOT_BASE62,
    "checksum_mismatch": KEY_CHECKSUM_MISMATCH,
}


def mask(value: str) -> str:
    """Return `value` with all but its prefix and last four characters hidden."""
    prefix = value[:_PREFIX_LENGTH] if value.startswith(_PREFIXES) else ""
    rest = value[len(prefix) :]
    tail = rest[-_SHOWN_TAIL:] if len(rest) > 3 * _SHOWN_TAIL else ""
    return f"{prefix}***{tail}"


class ApiKey:
    """An API key that keeps its value out of reprs, logs and pickles.

    `ApiKey` is a separate type from `str`. `repr` and `str` show a masked form,
    `reveal()` returns the value, and pickling raises `TypeError`.
    """

    __slots__ = ("_value",)

    def __init__(self, value: str, /) -> None:
        """Wrap `value`.

        Raises:
            AuthenticationError: `value` is not a string (`key_invalid`) or is
                empty (`key_empty`).
        """
        if not isinstance(value, str):
            raise client_error(
                KEY_INVALID,
                f"An API key is a string, not {type(value).__name__}",
                builtin=TypeError,
            )
        if not value:
            raise client_error(
                KEY_EMPTY, "An API key cannot be empty", builtin=ValueError
            )
        self._value = value

    def reveal(self) -> str:
        """Return the key's value."""
        return self._value

    def __repr__(self) -> str:
        return f"ApiKey({mask(self._value)!r})"

    __str__ = __repr__

    def __eq__(self, other: object) -> bool:
        if not isinstance(other, ApiKey):
            return NotImplemented
        return hmac.compare_digest(self._value, other._value)

    def __hash__(self) -> int:
        return hash(self._value)

    def __reduce__(self) -> NoReturn:
        raise TypeError("An ApiKey cannot be pickled; pass the key to each process")

    def __copy__(self) -> Self:
        return self

    def __deepcopy__(self, memo: dict[int, object]) -> Self:
        return self


type ApiKeyArgument = str | ApiKey | Callable[[], str | ApiKey] | Literal[False] | None


def _base62(number: int) -> str:
    digits = ""
    while number:
        number, remainder = divmod(number, 62)
        digits = _BASE62[remainder] + digits
    return digits.rjust(_CHECKSUM_LENGTH, "0")


def check_key_format(key: str) -> KeyFormatProblem | None:
    """Return the first way `key` breaks the DFO key format, or None.

    The check ignores length. After the prefix, the last six characters are the
    checksum and the rest is the body.
    """
    if not key.startswith(_PREFIXES):
        return "unknown_prefix"
    rest = key[_PREFIX_LENGTH:]
    if any(char not in _BASE62 for char in rest):
        return "not_base62"
    body, checksum = rest[:-_CHECKSUM_LENGTH], rest[-_CHECKSUM_LENGTH:]
    if not body or _base62(zlib.crc32(body.encode("ascii"))) != checksum:
        return "checksum_mismatch"
    return None


@dataclass(frozen=True, slots=True)
class ResolvedKey:
    """The key a lookup found, and where.

    Attributes:
        source: The source that won.
        key: The key, or None for anonymous use.
        path: The credentials file the key came from, for that source.
        profile: The profile the key came from, for that source.
    """

    source: KeySource
    key: ApiKey | None
    path: str | None = None
    profile: str | None = None


_ANONYMOUS = ResolvedKey("anonymous", None)


def _from_file(path: str, env: Mapping[str, str]) -> ResolvedKey | None:
    try:
        profiles = read_profiles(path)
    except CredentialsFileError as error:
        raise client_error(
            CREDENTIALS_FILE_INVALID,
            f"The credentials file {path} is invalid at line {error.line} "
            f"({error.reason}). {ACCEPTED_FORMAT} Fix it, or remove it and run "
            "`dfo auth login`.",
        ) from error
    except OSError as error:
        raise client_error(
            CREDENTIALS_FILE_UNREADABLE,
            f"The credentials file {path} exists but cannot be read "
            f"({error.strerror or type(error).__name__}). Make it a file its "
            "owner can read, or set DFO_CREDENTIALS_FILE to one.",
        ) from error
    if profiles is None:
        return None
    named = env.get("DFO_PROFILE") or None
    profile = named or "default"
    entries = profiles.get(profile)
    if entries is None:
        if named is None:
            return None
        raise client_error(
            PROFILE_NOT_FOUND,
            f"DFO_PROFILE names the profile {profile!r}, which {path} lacks. "
            f"Run `dfo auth login` with DFO_PROFILE={profile} to add it.",
        )
    if not entries.get("key"):
        raise client_error(
            PROFILE_WITHOUT_KEY,
            f"The profile {profile!r} in {path} has no key, or an empty one. "
            f"Run `dfo auth login` with DFO_PROFILE={profile} to add one.",
        )
    return ResolvedKey("credentials_file", ApiKey(entries["key"]), path, profile)


def _colab_secret() -> str | None:
    """The Colab secret's value, or None when it is missing or cannot be read.

    Colab raises its own classes for a missing secret and a notebook without
    access, and others when the lookup itself fails. Each leaves no secret.
    """
    if "google.colab" not in sys.modules:
        return None
    try:
        userdata = importlib.import_module("google.colab.userdata")
        value = userdata.get(_COLAB_SECRET)
    except Exception:  # any failed lookup leaves no secret
        return None
    return value if isinstance(value, str) and value else None


def _found(source: KeySource, value: str | ApiKey) -> ResolvedKey:
    return ResolvedKey(source, value if isinstance(value, ApiKey) else ApiKey(value))


def _from_argument(api_key: ApiKeyArgument) -> ResolvedKey | None:
    if api_key is None:
        return None
    if api_key is False:
        return _ANONYMOUS
    value = api_key() if callable(api_key) else api_key
    if not isinstance(value, str | ApiKey):
        given = "The api_key callable returned" if callable(api_key) else "api_key is"
        raise client_error(
            KEY_INVALID,
            f"{given} a {type(value).__name__}; a key is a string or an ApiKey. "
            "Pass None to look one up, or False for anonymous use.",
        )
    if value == "":
        raise client_error(
            KEY_EMPTY,
            "The api_key argument is empty. Pass a key, None to look one up, or "
            "False for anonymous use.",
        )
    return _found("argument", value)


def _source_name(resolved: ResolvedKey) -> str:
    match resolved.source:
        case "argument":
            return "the api_key argument"
        case "environment":
            return "DFO_API_KEY"
        case "credentials_file":
            return f"profile {resolved.profile!r} of {resolved.path}"
        case "colab":
            return f"the Colab secret {_COLAB_SECRET}"
        case "anonymous":
            return "no source"


def _lookup(
    api_key: ApiKeyArgument, env: Mapping[str, str], path: str | None
) -> ResolvedKey:
    if (from_argument := _from_argument(api_key)) is not None:
        return from_argument
    if from_env := env.get("DFO_API_KEY"):
        return _found("environment", from_env)
    from_file = _from_file(credentials_path(env=env) if path is None else path, env)
    if from_file is not None:
        return from_file
    if from_colab := _colab_secret():
        return _found("colab", from_colab)
    return _ANONYMOUS


def resolve_key(
    api_key: ApiKeyArgument = None,
    *,
    env: Mapping[str, str] | None = None,
    path: str | None = None,
) -> ResolvedKey:
    """Find the key a client sends, from the first source that has one.

    The sources, in order: the `api_key` argument (a key, an `ApiKey`, a callable
    returning one, or False for anonymous use); `DFO_API_KEY`; the credentials
    file, profile `DFO_PROFILE` else `default`; a Colab secret named
    `DFO_API_KEY`; otherwise anonymous. An empty `DFO_API_KEY` counts as unset.
    A key outside visible ASCII, 0x21 to 0x7E, raises `key_invalid`, naming its
    source and the position of the first such character. A key that fails the
    format check warns once per process and is used anyway.

    Args:
        api_key: The client's `api_key` argument.
        env: The environment, defaulting to this process's.
        path: The credentials file, defaulting to the contract's path.

    Raises:
        AuthenticationError: The `api_key` argument is empty (`key_empty`), the
            argument, or what its callable returns, is not a string or an
            `ApiKey`, or the key holds a character outside visible ASCII
            (`key_invalid`), the credentials file is invalid
            (`credentials_file_invalid`) or cannot be read
            (`credentials_file_unreadable`), `DFO_PROFILE` names a profile it
            lacks (`profile_not_found`), or the chosen profile has no key or an
            empty one (`profile_without_key`).
    """
    resolved = _lookup(api_key, os.environ if env is None else env, path)
    if resolved.key is None:
        return resolved
    value = resolved.key.reveal()
    if fault := key_fault(value):
        raise client_error(
            KEY_INVALID,
            f"The API key from {_source_name(resolved)} holds {fault}; a key "
            "holds visible ASCII only. Copy it again without spaces or line "
            "breaks.",
        )
    if problem := check_key_format(value):
        warn_once(
            ("key_format", problem, resolved.key),
            client_warning(
                _FORMAT_WARNINGS[problem],
                f"The API key {mask(value)} from the "
                f"{resolved.source.replace('_', ' ')} does not look like a DFO "
                f"key ({problem}); the client sends it anyway.",
            ),
        )
    return resolved


class KeyState:
    """The key a transport sends, shared by the copies `with_options` makes."""

    def __init__(self, api_key: ApiKeyArgument) -> None:
        """Resolve the key for `api_key` at build."""
        self._argument = api_key
        self.resolved = resolve_key(api_key)

    def refresh(self) -> bool:
        """Resolve the key again after a 401 and return whether it changed."""
        previous = self.resolved.key
        self.resolved = resolve_key(self._argument)
        return self.resolved.key != previous
