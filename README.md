# DFO SDK

Client libraries for the Development Finance Observatory APIs at [developmentfinance.org](https://developmentfinance.org). Ask a question about aid, debt, or development indicators in your own words, check what DFO understood, and get a versioned table back.

```bash
uv add "development-finance[pandas]"        # in a uv project
pip install "development-finance[pandas]"   # with pip
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
- [Compute a figure on DFO](python/docs/compute.md), such as growth, a ranking, or aid per person
- [Publish cards as a share](python/docs/shares.md) at a public link

## TypeScript

```bash
npm install @developmentfinance/client
```

The client has the search, choose, fetch, ref, lookup, analysis, card, and share calls under TypeScript names, and no CLI or disk cache. It runs in Node, Bun, Deno, Workers, and browsers. The API's CORS admits only the origins it lists, so a page on another origin calls your own server route, or a same-origin proxy of the API with `baseUrl: "/api/v1"`. Its [README](typescript/README.md) covers the quickstart and a web-app route.

## The contract

Both clients follow the [client contract](https://github.com/DevelopmentFinanceObservatory/spec-kit/blob/dev/python/client-contract/README.md) kept in spec-kit, which `contract/` copies at the commit `contract/SOURCE` names. A dataset ref and a saved answer written by one client work in the other. The TypeScript client reads the credentials file the Python CLI writes. [CONTRIBUTING.md](CONTRIBUTING.md) explains how the contract is synced and how releases are cut.
