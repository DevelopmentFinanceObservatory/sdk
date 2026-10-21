# DFO SDK

Client libraries for the Development Finance Observatory APIs at [developmentfinance.org](https://developmentfinance.org). Each client turns a question into a versioned table in two calls: search, then fetch.

## Python

```bash
pip install development-finance
```

```python
import dfo

data = dfo.search("ODA disbursements from Germany to Nigeria for basic health care").fetch()
```

The package imports as `dfo`. Its [README](python/README.md) has the quickstart and links to the full documentation.

## TypeScript

```bash
npm install @developmentfinance/client
```

The source lives in `typescript/`.

## The contract

Both clients follow the [client contract](https://github.com/DevelopmentFinanceObservatory/spec-kit/blob/dev/python/client-contract/README.md) kept in spec-kit, which `contract/` copies at the commit `contract/SOURCE` names, so a dataset ref, a credentials file, and a cache directory written by one client work in the other. [CONTRIBUTING.md](CONTRIBUTING.md) explains how the contract is synced and how releases are cut.
