"""The `dfo` command: `dfo auth login`, `dfo auth status` and `dfo cache clear`.

`login()` is the notebook form of `dfo auth login`. `dfo auth status` names the
key a client built with no options sends, and the base URL it sends it to when
`DFO_BASE_URL` sets one.
"""

import argparse
import getpass
import os
import shutil
import sys
from collections.abc import Sequence

from dfo._config.credentials import CredentialsFileError, store_key
from dfo._config.keys import check_key_format, mask, resolve_key
from dfo._config.paths import credentials_path
from dfo._core.codes import CREDENTIALS_FILE_INVALID, KEY_EMPTY
from dfo._core.errors import DfoError, client_error
from dfo._datasets.cache import cache_path
from dfo._http.transport import resolve_base_url

_PROMPT = "Paste your DFO API key: "


def _save(key: str) -> None:
    """Store `key` under the chosen profile and say where it went.

    Raises:
        AuthenticationError: The key is empty (`key_empty`) or cannot be stored
            (`key_invalid`), or the existing credentials file is invalid
            (`credentials_file_invalid`).
        InvalidRequestError: `DFO_PROFILE` names a profile the file cannot hold
            (`invalid_argument`).
    """
    key = key.strip()
    if not key:
        raise client_error(KEY_EMPTY, "No key given", builtin=ValueError)
    path = credentials_path()
    profile = os.environ.get("DFO_PROFILE") or "default"
    try:
        store_key(path, profile, key)
    except CredentialsFileError as error:
        raise client_error(
            CREDENTIALS_FILE_INVALID,
            f"The credentials file {path} is invalid at line {error.line} "
            f"({error.reason}); fix or remove it, then log in again",
            builtin=ValueError,
        ) from error
    print(f"Saved the key {mask(key)} to {path}, profile {profile!r}.")
    if problem := check_key_format(key):
        print(
            f"The key does not look like a DFO key ({problem}); it is saved and "
            "sent anyway."
        )


def login() -> None:
    """Ask for an API key and store it in the credentials file.

    The key goes to the profile `DFO_PROFILE` names, else `default`. The file is
    readable by its owner only.

    Raises:
        AuthenticationError: The key is empty (`key_empty`) or cannot be stored
            (`key_invalid`), or the existing credentials file is invalid
            (`credentials_file_invalid`).
        InvalidRequestError: `DFO_PROFILE` names a profile the file cannot hold
            (`invalid_argument`).
    """
    _save(getpass.getpass(_PROMPT))


def _auth_login(args: argparse.Namespace) -> None:
    _save(sys.stdin.read() if args.with_token else getpass.getpass(_PROMPT))


def _auth_status(_: argparse.Namespace) -> None:
    """Print the key a default client sends and the base URL its requests go
    to, naming `DFO_BASE_URL` when it sets one.

    Raises:
        InvalidRequestError: `DFO_BASE_URL` is not a valid base URL
            (`base_url_invalid`).
    """
    base_url = resolve_base_url(None)
    resolved = resolve_key()
    if resolved.key is None:
        print("No key: requests are anonymous.")
        print(f"Run `dfo auth login` to store one in {credentials_path()}.")
    else:
        where = {
            "argument": "the api_key argument",
            "environment": "the DFO_API_KEY environment variable",
            "credentials_file": f"{resolved.path}, profile {resolved.profile!r}",
            "colab": "the Colab secret DFO_API_KEY",
        }[resolved.source]
        print(f"Key {mask(resolved.key.reveal())} from {where}.")
    if base_url.source == "environment":
        print(
            f"Requests go to {base_url.url}, from the DFO_BASE_URL environment "
            "variable."
        )
    else:
        print(
            f"Requests go to {base_url.url}, the public API, the default while "
            "DFO_BASE_URL is unset."
        )


def _cache_clear(_: argparse.Namespace) -> None:
    """Empty the cache directory, or the directory it links to, and keep it.

    Raises:
        ValueError: The cache path names a file.
    """
    directory = cache_path()
    if not directory.exists():
        print(f"The cache at {directory} is already empty.")
        return
    if not directory.is_dir():
        raise ValueError(
            f"The cache path {directory} is a file, not a directory; remove it, "
            "or set DFO_CACHE_DIR to another directory"
        )
    for entry in directory.iterdir():
        if entry.is_dir() and not entry.is_symlink():
            shutil.rmtree(entry)
        else:
            entry.unlink()
    print(f"Cleared the cache at {directory}.")


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="dfo", description="Development Finance Observatory client."
    )
    commands = parser.add_subparsers(required=True, metavar="command")

    auth = commands.add_parser("auth", help="store and check your API key")
    auth_commands = auth.add_subparsers(required=True, metavar="command")
    login_command = auth_commands.add_parser(
        "login", help="store an API key in the credentials file"
    )
    login_command.add_argument(
        "--with-token",
        action="store_true",
        help="read the key from standard input, for CI",
    )
    login_command.set_defaults(run=_auth_login)
    status = auth_commands.add_parser("status", help="show which key the client sends")
    status.set_defaults(run=_auth_status)

    cache = commands.add_parser("cache", help="manage the download cache")
    cache_commands = cache.add_subparsers(required=True, metavar="command")
    clear = cache_commands.add_parser("clear", help="empty the cache")
    clear.set_defaults(run=_cache_clear)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    """Run the `dfo` command; return its exit status."""
    args = _parser().parse_args(argv)
    try:
        args.run(args)
    except (DfoError, ValueError, OSError) as error:
        print(f"dfo: {error}", file=sys.stderr)
        return 1
    return 0
