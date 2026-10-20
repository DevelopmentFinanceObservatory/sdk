"""Where the credentials file and the cache directory live.

Both follow the contract's rules (`contract/rules/README.md`), so every DFO client
finds the same file and the same cache. Each function takes the platform, the
home directory and the environment, defaulting to this process's, so the
contract's vectors replay on any machine. An empty variable counts as unset.
"""

import ntpath
import os
import posixpath
import sys
from collections.abc import Mapping
from os import PathLike
from pathlib import Path
from typing import Literal

type Platform = Literal["linux", "macos", "windows"]

# readerkit's layout version, the app, and the client cache's layout version.
CACHE_LAYOUT = ("v1", "dfo", "cache1")


def current_platform() -> Platform:
    """Return this process's platform in the contract's terms."""
    if sys.platform == "win32":
        return "windows"
    if sys.platform == "darwin":
        return "macos"
    return "linux"


def _context(
    env: Mapping[str, str] | None, platform: Platform | None, home: str | None
) -> tuple[Mapping[str, str], Platform, str]:
    return (
        os.environ if env is None else env,
        current_platform() if platform is None else platform,
        str(Path.home()) if home is None else home,
    )


def _set(env: Mapping[str, str], name: str) -> str | None:
    return env.get(name) or None


def credentials_path(
    *,
    env: Mapping[str, str] | None = None,
    platform: Platform | None = None,
    home: str | None = None,
) -> str:
    """Return the path of the credentials file, whether or not it exists."""
    env, platform, home = _context(env, platform, home)
    if explicit := _set(env, "DFO_CREDENTIALS_FILE"):
        return explicit
    if platform == "windows":
        appdata = _set(env, "APPDATA") or ntpath.join(home, "AppData", "Roaming")
        return ntpath.join(appdata, "dfo", "credentials.toml")
    config = _set(env, "XDG_CONFIG_HOME") or posixpath.join(home, ".config")
    return posixpath.join(config, "dfo", "credentials.toml")


def cache_root(
    cache_dir: str | PathLike[str] | None = None,
    *,
    env: Mapping[str, str] | None = None,
    platform: Platform | None = None,
    home: str | None = None,
) -> str:
    """Return the cache root: the argument, a variable, or the platform's cache."""
    env, platform, home = _context(env, platform, home)
    path = ntpath if platform == "windows" else posixpath
    chosen = (
        (os.fspath(cache_dir) if cache_dir is not None else None)
        or _set(env, "DFO_CACHE_DIR")
        or _set(env, "BBLOCKS_CACHE_DIR")
    )
    if chosen:
        if chosen == "~" or chosen.startswith(("~/", "~\\")):
            chosen = home + chosen[1:]
        return path.normpath(chosen)
    if platform == "windows":
        local = _set(env, "LOCALAPPDATA") or ntpath.join(home, "AppData", "Local")
        return ntpath.join(local, "readerkit", "Cache")
    if platform == "macos":
        return posixpath.join(home, "Library", "Caches", "readerkit")
    cache_home = _set(env, "XDG_CACHE_HOME") or posixpath.join(home, ".cache")
    return posixpath.join(cache_home, "readerkit")


def cache_directory(
    cache_dir: str | PathLike[str] | None = None,
    *,
    env: Mapping[str, str] | None = None,
    platform: Platform | None = None,
    home: str | None = None,
) -> str:
    """Return the client's cache directory, `<root>/v1/dfo/cache1`."""
    root = cache_root(cache_dir, env=env, platform=platform, home=home)
    path = ntpath if (platform or current_platform()) == "windows" else posixpath
    return path.join(root, *CACHE_LAYOUT)
