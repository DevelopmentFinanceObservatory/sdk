# DFO SDK

Client libraries for the Development Finance Observatory APIs at [developmentfinance.org](https://developmentfinance.org). Ask a question about aid, debt or development indicators in your own words, check what DFO understood, and get a versioned table back.

```bash
pip install "development-finance[pandas]"
```

```python
import dfo

answer = dfo.search("ODA from Germany to Nigeria")
print(answer)
df = answer.fetch().to_pandas()
```

```text
Germany's gross disbursements to Nigeria for official development assistance, 1960 to 2024. Current US dollars · OECD DAC2a.
  Fetch: answer.fetch()
```

The Python package imports as `dfo`. Its [README](python/README.md) has a recipe for each common task:

- [Ask a question and read the answer](python/README.md#ask-a-question-and-read-the-answer)
- [Choose a reading](python/README.md#choose-a-reading)
- [Fetch other years or places](python/README.md#fetch-other-years-or-places)
- [Keep group and total rows](python/README.md#keep-group-and-total-rows)
- [Save the data and load it later](python/README.md#save-the-data-and-load-it-later)
- [Refresh later and tell if the data changed](python/README.md#refresh-later-and-tell-if-the-data-changed)
- [Share an answer](python/README.md#share-an-answer)
- [Look up a place code](python/README.md#look-up-a-place-code)

## TypeScript

```bash
npm install @developmentfinance/client
```

The client runs in Node and the browser and has the same calls under TypeScript names. Its [README](typescript/README.md) covers the quickstart and a web-app route.

## The contract

Both clients follow the [client contract](https://github.com/DevelopmentFinanceObservatory/spec-kit/blob/dev/python/client-contract/README.md) kept in spec-kit, which `contract/` copies at the commit `contract/SOURCE` names. A dataset ref, a saved answer, a credentials file and a cache directory written by one client work in the other. [CONTRIBUTING.md](CONTRIBUTING.md) explains how the contract is synced and how releases are cut.
