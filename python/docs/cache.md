# The cache

The client keeps every file it downloads, keyed by digest, so fetching a ref a second time reads the disk and makes no request. The cache also lets a stored version load with no network at all.

## Where it lives

The cache root is the first of:

1. the `cache_dir=` argument to `Client` or `configure`;
2. `DFO_CACHE_DIR`;
3. `BBLOCKS_CACHE_DIR`, shared with the bblocks family of packages;
4. the platform's cache directory: `~/.cache/readerkit` on Linux (or `$XDG_CACHE_HOME/readerkit`), `~/Library/Caches/readerkit` on macOS, and `%LOCALAPPDATA%\readerkit\Cache` on Windows.

The client's entries sit under `<root>/v1/dfo/cache1`, laid out as:

```text
v1/dfo/cache1/
├── files/
│   └── sha256/
│       └── 598ce1c1e63d53ab7326cec266aa9a523d9cc2f1acfba280fd2cf2f01649fbde
└── manifests/
    └── spec_774d6c001a6250aa67ca676ab067895e/
        └── cv_b92d94774702c7f05f2075d0b03dd756/
            └── parquet.json
```

`files/sha256/<hex>` holds a downloaded file under its digest. `manifests/<spec_id>/<content_version>/<rendering>.json` holds the version's manifest, where the rendering is `parquet` for the long layout and `parquet-frame` for the frame. Every DFO client uses this layout, so a Python script and a TypeScript service on one machine share their downloads.

Each entry is written to a temporary name and renamed into place, so a reader never sees half a file, and two processes can fill one cache without a lock. A read hashes the file again, and a file whose bytes differ from its digest counts as a miss and downloads afresh.

## Size and clearing

The cache keeps up to 2 GiB of files and evicts the least recently read first. A write the disk refuses logs a warning on the `dfo` logger and the fetch carries on.

`dfo cache clear` empties it:

```bash
dfo cache clear
```

```text
Cleared the cache at /home/amina/.cache/readerkit/v1/dfo/cache1.
```

To point one client elsewhere, or fetch without the cache:

```python
import dfo

with dfo.Client(cache_dir="./dfo-cache") as client:
    data = client.search("GDP of Kenya").fetch()

with dfo.Client(cache=False) as client:   # neither reads nor writes the cache
    data = client.search("GDP of Kenya").fetch()
    print(data.rows)
```

## What the cache serves

A ref names exact versions, so `fetch(ref)` reads each version from the cache when its file and manifest are there, and asks the server only for the rest. A spec asks for the latest version, so `fetch(spec)` and `answer.fetch()` always go to the server to build it. The download then comes from the cache when that version's file is already there.

## Offline: DFO_OFFLINE=1

`DFO_OFFLINE=1` limits fetches to the cache. A ref whose versions are all cached loads, and the dataset reports `stale` as True, because the client did not ask the server whether anything changed:

```python
import os
from pathlib import Path

import dfo

data = dfo.search("ODA disbursements from Germany to Nigeria for basic health care").fetch()
Path("health.ref.json").write_text(data.ref.to_json())

os.environ["DFO_OFFLINE"] = "1"

ref = dfo.DatasetRef.from_json(Path("health.ref.json").read_text())
offline = dfo.fetch(ref)
print(offline.stale)    # True

try:
    dfo.fetch(ref.members[0].spec)
except dfo.NetworkError as error:
    print(error.code)   # offline
```

Two fetches raise `NetworkError` with the code `offline`:

- a spec, or an answer, since its latest version builds on the server;
- a ref with a version the cache lacks.

`DFO_OFFLINE` governs fetches only, so `dfo.search` still sends its request. Set the variable before the fetch runs; the client reads it on each call.

## Stale reads

`data.stale` is True only for a dataset read from the cache under `DFO_OFFLINE=1`. The rows are still the exact version the ref names, since a version never changes once built. What `stale` warns of is a check skipped: the server may have revoked the version, or published a newer one. The display adds a line for it:

```text
<Dataset Germany's gross ODA disbursements to Nigeria for basic health care, 1995 to 2024. ...
  Source: OECD Creditor Reporting System (CRS)
  Version: cv_b92d94774702c7f05f2075d0b03dd756
  Rows: 30
  Stale: read from the cache without asking for a newer version>
```

`stale` travels with the dataset into the file `save` writes. Fetch the ref again online to clear it.

## Next

- [Datasets and versions](datasets.md): refs, and where a stored version comes from when the cache lacks it.
- [Errors](errors.md): `NetworkError` and the `offline` code.
