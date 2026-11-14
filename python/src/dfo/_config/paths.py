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


def _explicit_root(
    cache_dir: str | PathLike[str] | None,
    env: Mapping[str, str],
    platform: Platform,
    home: str,
) -> str | None:
    """The root the argument, `DFO_CACHE_DIR` or `BBLOCKS_CACHE_DIR` sets, or None.

    Raises:
        ValueError: The root starts `~name`, and the platform knows no home
            directory for that user.
    """
    path = ntpath if platform == "windows" else posixpath
    chosen = (
        (os.fspath(cache_dir) if cache_dir is not None else None)
        or _set(env, "DFO_CACHE_DIR")
        or _set(env, "BBLOCKS_CACHE_DIR")
    )
    if not chosen:
        return None
    if chosen == "~" or chosen.startswith(("~/", "~\\")):
        chosen = home + chosen[1:]
    elif chosen.startswith("~"):
        expanded = path.expanduser(chosen)
        if expanded.startswith("~"):
            user = chosen.replace("\\", "/").split("/", 1)[0]
            raise ValueError(
                f"The cache directory {chosen!r} starts with {user}, and no "
                "user of that name has a home directory"
            )
        chosen = expanded
    return path.normpath(chosen)


def _platform_root(
    app: str, env: Mapping[str, str], platform: Platform, home: str
) -> str:
    """The platform's cache directory for `app`."""
    if platform == "windows":
        local = _set(env, "LOCALAPPDATA") or ntpath.join(home, "AppData", "Local")
        return ntpath.join(local, app, "Cache")
    if platform == "macos":
        return posixpath.join(home, "Library", "Caches", app)
    cache_home = _set(env, "XDG_CACHE_HOME") or posixpath.join(home, ".cache")
    return posixpath.join(cache_home, app)


def cache_root(
    cache_dir: str | PathLike[str] | None = None,
    *,
    env: Mapping[str, str] | None = None,
    platform: Platform | None = None,
    home: str | None = None,
) -> str:
    """Return the cache root, from the argument, a variable, or the platform's
    cache directory for `dfo`.

    A leading `~` is the home directory, and a leading `~name` the home
    directory of the user `name`.

    Raises:
        ValueError: The root starts `~name`, and the platform knows no home
            directory for that user.
    """
    env, platform, home = _context(env, platform, home)
    explicit = _explicit_root(cache_dir, env, platform, home)
    return explicit or _platform_root("dfo", env, platform, home)


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


def legacy_cache_directory(
    cache_dir: str | PathLike[str] | None = None,
    *,
    env: Mapping[str, str] | None = None,
    platform: Platform | None = None,
    home: str | None = None,
) -> str | None:
    """Return the cache directory of Python clients before 0.2.0, or None under
    an explicit root.

    Those clients kept the platform default under `readerkit` in place of
    `dfo`, so the legacy directory is `<readerkit root>/v1/dfo/cache1`. A root
    set by the argument, `DFO_CACHE_DIR` or `BBLOCKS_CACHE_DIR` is the same in
    both releases, so it has no legacy directory.

    Raises:
        ValueError: The root starts `~name`, and the platform knows no home
            directory for that user.
    """
    env, platform, home = _context(env, platform, home)
    if _explicit_root(cache_dir, env, platform, home) is not None:
        return None
    path = ntpath if platform == "windows" else posixpath
    return path.join(_platform_root("readerkit", env, platform, home), *CACHE_LAYOUT)
