# development-finance

Python client for the Development Finance Observatory APIs at [developmentfinance.org](https://developmentfinance.org).

```bash
pip install development-finance
```

The package imports as `dfo`.

## Development

The repository root holds the contract, the pre-commit configuration, and the CI workflows. See `CONTRIBUTING.md` there. From this directory:

```bash
uv sync
uv run pytest
uv run ruff check
uv run ruff format --check
uv run ty check
```
