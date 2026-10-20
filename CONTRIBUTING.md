# Contributing

## Layout

- `python/` holds the `development-finance` package, which imports as `dfo`.
- `typescript/` will hold the `@developmentfinance/client` package.
- `contract/` holds the client contract: a copy of the `dfo_client_contract` package data from the spec-kit repository. Both clients generate code from it and replay its scenarios.
- `scripts/` holds the tools shared by the clients.

The root holds `.pre-commit-config.yaml` and `.github/workflows/`, which cover both packages.

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
pre-commit run --all-files
```

## Syncing the contract

`contract/` is never edited by hand. Change the contract in spec-kit, then copy it from a spec-kit checkout:

```bash
scripts/sync_contract.py ../spec-kit
```

The script copies the package data into `contract/` and writes the checkout's commit to `contract/SOURCE`. It refuses a checkout with uncommitted changes to the package data, because `SOURCE` would then name a commit that does not hold them. Run it with `--check` to exit non-zero on any difference.

CI runs two checks on every change to `contract/`:

- `scripts/sync_contract.py --check` against the public spec-kit tree at `SOURCE`.
- `scripts/check_contract_pin.py`, which fails unless `SOURCE` is the rev that dfo-apis `dev` pins for `dfo-spec-kit-client-contract`, or an ancestor of it. The clients never replay scenarios that dfo-apis does not check.

## Releases

A release is a tag on `main`:

- `python-v<version>` publishes `development-finance` to PyPI. The tag must equal `python-v` plus the version in `python/pyproject.toml`.
- `typescript-v<version>` publishes `@developmentfinance/client` to npm.

Publishing uses OIDC trusted publishing from `.github/workflows/release.yml`; no token is stored.
