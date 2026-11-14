# Use the cache and work offline

The client keeps every file it downloads on disk, keyed by its SHA-256 digest, beside the manifest that describes it. A fetch of a ref reads the versions it names from disk when the cache holds them, without a request. A fetch of a spec asks the server for the newest version, and reads the file from disk when that version is already there. With `DFO_OFFLINE=1` the client works from the cache alone.

## Work offline

Fetch once with the network, then set `DFO_OFFLINE=1`. A ref loads the exact versions it names, and a spec loads the newest version the cache holds. Both datasets report `stale` as True, because the client read from the cache alone, and the display gives the time the file left the server:

```text
<Dataset Germany's gross ODA disbursements to Nigeria for basic health care, 1995 to 2024. Current US dollars · OECD Creditor Reporting System (CRS).
  Source: OECD Creditor Reporting System (CRS)
  Version: cv_b92d94774702c7f05f2075d0b03dd756 (exact), pinned
  Rows: 30
  Stale: read from the cache without asking for a newer version, fetched 13 November 2026 09:14 UTC
  Keep: data.save(path) · newest later: dfo.fetch(data.ref, latest=True)>
True True
DFO_OFFLINE=1 is set, and POST https://developmentfinance.org/api/v1/search/resolve needs the network [offline]
```

```python
import os

import dfo
from dfo.errors import NetworkError
from dfo.types import Member

data = dfo.search(
    "ODA disbursements from Germany to Nigeria for basic health care"
).fetch()
data.save("health.parquet")

os.environ["DFO_OFFLINE"] = "1"
try:
    saved = dfo.fetch(dfo.load("health.parquet").ref)
    print(saved)

    member = data.members[0]
    assert isinstance(member, Member)  # a search fetches dataset members
    newest = dfo.fetch(member.spec)
    print(newest.stale, newest.ref == data.ref)

    dfo.search("GDP of Kenya")
except NetworkError as error:
    print(error)
finally:
    del os.environ["DFO_OFFLINE"]
```

Under `DFO_OFFLINE=1` every request raises `NetworkError` with the code `offline` before it is sent, so `dfo.search`, `answer.choose`, and the lookups raise it. A fetch raises it when the cache holds no version of a spec, when a ref names a version the cache lacks, when the cache is off, and when a spec is narrowed with `window`, `entities`, or `facets`, since only the server knows which version a narrowing builds. The client reads the variable on each call, so set it before the call runs.

`stale` is True only under `DFO_OFFLINE=1`, and it travels into the file `save` writes. Fetch again with the network to clear it.

## Tell a cache hit from a download

`data.from_cache` is True when the fetch read any member's file from disk, online or offline. A ref fetch whose versions are on disk is one, and so is a spec fetch whose newest version the server named and the cache already held. The display then carries a line with the time the file left the server, which `data.fetched_at` holds as a UTC `datetime`:

```text
  Cached: read from the cache, fetched 13 November 2026 09:14 UTC
```

The cache records the time beside each file it downloads. A file stored by release 0.1.0 has no time, so its line ends `fetch time unknown` and `fetched_at` is None until the file downloads again. A dataset of several members gives the earliest member's time. A fresh download sets `fetched_at` to the time it arrived and adds no line.

## Where the cache lives

The cache root comes from `cache_dir=`, then `DFO_CACHE_DIR`, then `BBLOCKS_CACHE_DIR`, then the platform's cache directory, such as `~/.cache/readerkit` on Linux. [Settings](settings.md#cache-directory) gives each platform's directory.

The entries sit under `<root>/v1/dfo/cache1`. After the fetch above, the cache holds one file and its manifest:

```text
v1/dfo/cache1/
├── fetched/
│   └── sha256/
│       └── 421efacc2dc010af38112a087b0b49ff5539f61d2afd12a88272b27e99b5f5db
├── files/
│   └── sha256/
│       └── 421efacc2dc010af38112a087b0b49ff5539f61d2afd12a88272b27e99b5f5db
└── manifests/
    └── spec_774d6c001a6250aa67ca676ab067895e/
        └── cv_b92d94774702c7f05f2075d0b03dd756/
            └── parquet.json
```

`files/sha256/<hex>` holds a downloaded file under its digest, and `fetched/sha256/<hex>` the UTC time it left the server, such as `2026-11-13T09:14:05Z`. `manifests/<spec_id>/<content_version>/<rendering>.json` holds the version's manifest, where the rendering is `parquet` for the long table and `parquet-frame` for the frame. Clients that read this layout share the downloads on one machine.

A read hashes the file again, and a file whose bytes differ from its digest counts as missing and downloads afresh. Each entry is written to a temporary name and renamed into place, so a reader sees whole files only, and several processes can share one cache. A relative `cache_dir` resolves against the working directory when the client is built.

## Clear, move, or disable the cache

The cache keeps up to 2 GiB of files and removes the least recently read first. `dfo cache clear` empties the cache directory, keeps the directory, and prints its path:

```bash
dfo cache clear
```

Pass `cache_dir` to give a client its own cache, or `cache=False` to fetch without one:

```python
import dfo

with dfo.Client(cache_dir="./dfo-cache") as client:
    data = client.search(
        "ODA disbursements from Germany to Nigeria for basic health care"
    ).fetch()

with dfo.Client(cache=False) as client:  # reads and writes nothing on disk
    data = client.search(
        "ODA disbursements from Germany to Nigeria for basic health care"
    ).fetch()
print(len(data))
```

```text
30
```

`dfo.configure(cache=False)` does the same for `dfo.search` and `dfo.fetch`, and `dfo.configure(cache_dir=...)` moves their cache.

## Next

- [Fetch and keep a dataset](datasets.md) covers refs, `latest=True`, and what happens when a version is gone from the server and the cache.
- [Errors](errors.md) covers `NetworkError` and the `offline` code.
