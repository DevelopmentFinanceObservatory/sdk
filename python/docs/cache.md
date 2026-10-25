# Use the cache and work offline

The client keeps every file it downloads on disk, keyed by its SHA-256 digest, beside the manifest that describes it. A fetch of a ref reads the versions it names from disk and sends no request. A fetch of a spec asks the server for the newest version, and reads the file from disk when that version is already there. With `DFO_OFFLINE=1` the client works from the cache alone.

## Work offline

Fetch once with the network, then set `DFO_OFFLINE=1`. A ref loads the exact versions it names, and a spec loads the newest version the cache holds. Both datasets report `stale` as True, because the client did not ask the server whether anything changed:

```text
<Dataset Germany's gross ODA disbursements to Nigeria for basic health care, 1995 to 2024. Current US dollars · OECD Creditor Reporting System (CRS).
  Source: OECD Creditor Reporting System (CRS)
  Version: cv_b92d94774702c7f05f2075d0b03dd756 (exact), pinned
  Rows: 30
  Stale: read from the cache without asking for a newer version
  Keep: data.save(path) · newest later: dfo.fetch(data.ref, latest=True)>
True True
DFO_OFFLINE=1 is set, and POST https://developmentfinance.org/api/v1/search/resolve needs the network [offline]
```

```python
import os

import dfo
from dfo.errors import NetworkError

data = dfo.search(
    "ODA disbursements from Germany to Nigeria for basic health care"
).fetch()
data.save("health.parquet")

os.environ["DFO_OFFLINE"] = "1"
try:
    saved = dfo.fetch(dfo.load("health.parquet").ref)
    print(saved)

    newest = dfo.fetch(data.members[0].spec)
    print(newest.stale, newest.ref == data.ref)

    dfo.search("GDP of Kenya")
except NetworkError as error:
    print(error)
finally:
    del os.environ["DFO_OFFLINE"]
```

Under `DFO_OFFLINE=1` every request raises `NetworkError` with the code `offline` before it is sent, so `dfo.search`, `answer.choose` and the lookups raise it. A fetch raises it when the cache holds no version of a spec, when a ref names a version the cache lacks, when the cache is off, and when a spec is narrowed with `window`, `entities` or `facets`, since only the server knows which version a narrowing builds. The client reads the variable on each call, so set it before the call runs.

`stale` travels into the file `save` writes. Fetch again with the network to clear it.

## Where the cache lives

The cache root is the first of these that is set:

1. `cache_dir=` on `dfo.Client`, `dfo.AsyncClient` or `dfo.configure`
1. `DFO_CACHE_DIR`
1. `BBLOCKS_CACHE_DIR`, shared with the bblocks packages
1. the platform's cache directory: `~/.cache/readerkit` on Linux (or `$XDG_CACHE_HOME/readerkit`), `~/Library/Caches/readerkit` on macOS, and `%LOCALAPPDATA%\readerkit\Cache` on Windows.

The entries sit under `<root>/v1/dfo/cache1`. After the fetch above, the cache holds one file and its manifest:

```text
v1/dfo/cache1/
├── files/
│   └── sha256/
│       └── 421efacc2dc010af38112a087b0b49ff5539f61d2afd12a88272b27e99b5f5db
└── manifests/
    └── spec_774d6c001a6250aa67ca676ab067895e/
        └── cv_b92d94774702c7f05f2075d0b03dd756/
            └── parquet.json
```

`files/sha256/<hex>` holds a downloaded file under its digest. `manifests/<spec_id>/<content_version>/<rendering>.json` holds the version's manifest, where the rendering is `parquet` for the long table and `parquet-frame` for the frame. Clients that read this layout share the downloads on one machine.

A read hashes the file again, and a file whose bytes differ from its digest counts as missing and downloads afresh. Each entry is written to a temporary name and renamed into place, so a reader sees whole files only, and several processes can share one cache. A relative `cache_dir` resolves against the working directory when the client is built.

## Clear it, move it, or turn it off

The cache keeps up to 2 GiB of files and removes the least recently read first. `dfo cache clear` empties the cache directory, keeps the directory, and prints its path:

```bash
dfo cache clear
```

To give one client its own cache, or fetch with no cache at all:

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

- [Fetch and keep a dataset](datasets.md): refs, `latest=True`, and what happens when a version is gone from the server and the cache.
- [Errors](errors.md): `NetworkError` and the `offline` code.
