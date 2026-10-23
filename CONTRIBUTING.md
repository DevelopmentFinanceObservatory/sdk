# Contributing

## Layout

- `python/` holds the `development-finance` package, which imports as `dfo`.
- `typescript/` holds the `@developmentfinance/client` package.
- `contract/` holds the client contract, a copy of the `dfo_client_contract` package data from the spec-kit repository at the commit `contract/SOURCE` names. Git tracks only `SOURCE`; `scripts/sync_contract.py` fetches the rest. Both clients generate code from the copy and replay its scenarios.
- `scripts/` holds the tools shared by the clients.

The root holds `.pre-commit-config.yaml` and `.github/workflows/`, which cover both packages.

## Package layout

Both packages group their modules into the same seven layers. A module imports at runtime only from its own layer and the layers below it. A type-only import, under `if TYPE_CHECKING:` in Python or `import type` in TypeScript, may name any layer.

| Layer, top first | Python            | TypeScript       | Holds                                                                                                   |
| ---------------- | ----------------- | ---------------- | ------------------------------------------------------------------------------------------------------- |
| client           | `dfo/_client/`    | `src/client.ts`  | the client, the module functions and the CLI                                                            |
| search           | `dfo/_search/`    | `src/search/`    | Search, answers, choices, answer text, and graph and code lookups                                       |
| datasets         | `dfo/_datasets/`  | `src/datasets/`  | fetch, ref resolution, operations, builds, datasets, Parquet and Arrow, bundles, the cache and progress |
| http             | `dfo/_http/`      | `src/http/`      | the transport and its hooks                                                                             |
| config           | `dfo/_config/`    | `src/config/`    | the API key, the credentials file, paths and the environment                                            |
| core             | `dfo/_core/`      | `src/core/`      | errors and warnings, refusal mapping, the public data classes, wire parsing and the DatasetRef format   |
| generated        | `dfo/_generated/` | `src/generated/` | literals and types the generators write from the contract                                               |

The public names sit above every layer. In Python they are `dfo/__init__.py`, the one public namespace; each layer's `__init__.py` holds only a docstring. In TypeScript they are the entry points at the `src/` root (`index.ts`, `index.node.ts`, `wire.ts` and `arrow.ts`), which re-export from the layers. `_version.py` and `src/version.ts` hold the version constant and sit below every layer. The sync twin of each Python async module, under `dfo/_sync/`, sits in the layer of its source.

Two checks enforce the rule, and each fails on a runtime import from a higher layer:

- Python: import-linter, through the `Layers` contract in `[tool.importlinter]` in `python/pyproject.toml`. Run `uv run --directory python lint-imports`. A layer module must not `import dfo`, because the package root imports every layer.
- TypeScript: `@typescript-eslint/no-restricted-imports` in `typescript/eslint.config.js`, one rule per layer directory, run by `pnpm --dir typescript lint`.

CI and the pre-commit hooks run both.

The Python tests follow the package: `python/tests/<layer>/` tests the modules of a layer, `python/tests/_async/<layer>/` its async modules, and `python/tests/_sync/<layer>/` is generated from those.

## Setup

```bash
uv sync --directory python
pre-commit install
```

Run the Python checks from the root:

```bash
uv run --directory python pytest
uv run --directory python ruff check
uv run --directory python ruff format --check
uv run --directory python ty check
uv run --directory python lint-imports
pre-commit run --all-files
```

## TypeScript

The package uses pnpm, at the version `packageManager` in `typescript/package.json` names, Node 22.18 or later, which runs the TypeScript sources, tests and scripts directly, and uv. `pnpm test`, `pnpm test:e2e`, `pnpm generate` and `pnpm generate:check` first run `scripts/fetch-contract.ts`, also `pnpm fetch-contract`, which brings `contract/` to `SOURCE` by running `scripts/sync_contract.py` through uv on Python 3.12 or later, so a machine whose `python3` is older still works. The fetch does nothing when the copy is current. When uv is missing or the fetch fails, it stops the command and says what to run. Run the checks from the root:

```bash
pnpm --dir typescript install
pnpm --dir typescript lint
pnpm --dir typescript typecheck
pnpm --dir typescript test
pnpm --dir typescript build
pnpm --dir typescript generate:check
```

`pnpm build` writes JavaScript and declaration files to `typescript/dist/`. The package is ESM only. Its `.` export has a `node` condition, whose entry point reads the credentials file from the file system. Every other platform loads the entry point without it.

### Generated code

`typescript/src/generated/` is never edited by hand. After a contract sync, regenerate it and commit the result:

```bash
pnpm --dir typescript generate
```

- `scripts/generate-wire.ts` writes `openapi.ts`, the wire types, from `contract/served/openapi.json` with openapi-typescript. It opens every string enum into a union with any other string, joins `UnknownPart` to the array of parts discriminated on `status`, and exports one type per schema, with `Operation` named `RequestedOperation`.
- `scripts/generate-contract.ts` writes `strict.ts` from `contract/strict-fields.json` and `actions.ts` from `contract/actions.json`. It fails when a strict field is not required, or is nullable, in `contract/served/openapi.json`.

`pnpm generate:check` exits non-zero when a generated file differs from what the contract generates. CI and the pre-commit hooks run it.

## Syncing the contract

Git tracks only `contract/SOURCE`, the spec-kit commit the clients follow. The rest of `contract/` is fetched from the public spec-kit repository at that commit, and git ignores it:

```bash
uv run --no-project --python '>=3.12' scripts/sync_contract.py
```

The script downloads the GitHub archive of the commit, extracts the package data into `contract/` and the package's README, which states the contract's rules, to `contract/README.md`, and records the commit in `contract/.synced`. It does nothing when `.synced` already names `SOURCE`. It builds the copy in a scratch directory and swaps it in, so a failed download leaves the old copy in place. The Python tests, `scripts/gen_wire.py`, `scripts/gen_errors.py` and the TypeScript package scripts that read `contract/` run the fetch themselves when the copy is missing or `.synced` differs from `SOURCE`, and stop with the error when the fetch fails.

To move the clients to a new contract, change it in spec-kit, push the change, and write the new commit to `contract/SOURCE`. For a change that is not pushed yet, copy it from a spec-kit checkout:

```bash
uv run --no-project --python '>=3.12' scripts/sync_contract.py --from ../spec-kit
```

That form copies the same files and writes the checkout's commit to `SOURCE`. It refuses a checkout with uncommitted changes to the package data or the README, because `SOURCE` would then name a commit that does not hold them; `--allow-dirty` overrides the refusal, and the copy it writes stays in place until `SOURCE` changes or `contract/.synced` is deleted.

CI runs `scripts/check_contract_pin.py` on every change to `contract/SOURCE`. It fails unless `SOURCE` is the rev that dfo-apis `dev` pins for `dfo-spec-kit-client-contract`, or an ancestor of it. The clients replay only scenarios that dfo-apis checks.

## Generated code

These Python files are generated, and CI fails when one differs from what its generator writes. Do not edit them by hand. Change the source and run the generator from `python/`:

```bash
uv run python ../scripts/gen_sync.py
uv run python ../scripts/gen_errors.py
uv run python ../scripts/gen_wire.py
```

- `scripts/gen_sync.py` writes the sync twin of each async module at the same path under `python/src/dfo/_sync/`, so `_http/transport.py` becomes `_sync/_http/transport.py`, and each test under `python/tests/_sync/` from its twin under `python/tests/_async/`, so the sync client passes the same tests as the async one. `ASYNC_MODULES` in the script lists the async modules.
- `scripts/gen_errors.py` writes `python/src/dfo/_generated/error_map.py` from `contract/actions.json`, `contract/client-codes.json` and `contract/warning-codes.json`: each refusal code's caller action, each no_data reason's gap kind, and the class and retryable flag of each code the client raises or warns with itself.
- `scripts/gen_wire.py` writes `python/src/dfo/_generated/wire.py`, a `TypedDict` per schema of `contract/served/openapi.json`, and `python/src/dfo/_generated/strict.py`, the members and enum values `contract/strict-fields.json` lists.

The files in `_generated/` hold literals and types only and import nothing from `dfo`. `dfo._core.codes` builds the `ClientCode` and `WarningCode` constants from the error map, and `dfo._core.parse.require` checks a response against the strict members. A code the contract adds fails `python/tests/core/test_errors.py` until `dfo._core.codes` has a constant for it.

Each generator takes `--check`, which writes nothing and exits 1 on a difference.

## Async source rules

The async modules are the source of both clients, and `scripts/gen_sync.py` derives the sync ones by replacing tokens. A module stays convertible when it follows these rules, and the generator refuses one that breaks them:

- No import of `asyncio`, `anyio` or `trio`, and so no `asyncio.gather`, `TaskGroup`, `asyncio.timeout` or `wait_for`. The members of a dataset build one after another, and deadlines come from the transport's clock.
- Sleep and the clock come from the transport (`dfo._http.hooks`), so a test or a scenario replay can inject them.
- Import other async modules by absolute name, such as `from dfo._http.transport import AsyncTransport`. The generator points the sync module at `dfo._sync._http.transport`, and refuses `from dfo._http import transport`, which it cannot repoint.
- An async name the token map lacks (`async`, `await`, an `Async*` class, `__aenter__`, `aclose`, `aread`, `aiter_*`) fails the run. Add the pair to `SUBS` in the script. A pair no source uses also fails the run, so a renamed name in httpx2 shows up there.
- Code that does no I/O, such as the cache, Parquet and Arrow code, is plain sync code in a module both clients call.
- An async test uses `pytestmark = pytest.mark.anyio` and a sync `def` handler for `httpx2.MockTransport`, which serves both clients.

## Releases

A release is a tag on `main`:

- `python-v<version>` publishes `development-finance` to PyPI. The tag must equal `python-v` plus the version in `python/pyproject.toml`.
- `typescript-v<version>` publishes `@developmentfinance/client` to npm.

Publishing uses OIDC trusted publishing from `.github/workflows/release.yml`, so the repository stores no token.

## Dependency ranges

A runtime dependency in `python/pyproject.toml` takes a lower bound and no upper bound, so the package installs beside the newest releases of what it uses. `uv.lock` pins the versions the tests run against.

`httpx2` and `httpcore2` are the one exception, bounded to `>=2.15,<2.16`. `_keep_to_deadlines` in `python/src/dfo/_http/transport.py` reads the connection pool's private layout, which a minor release may move. To take a new minor, run the Python suite against it and move both bounds and the lock in one change.
