# Cards and shares

`dfo.cards` stores a chart, a table, or a headline number that DFO draws from a Dataset, and `dfo.share` publishes cards under one link that a page or an embed shows.

Cards and shares are public. Anyone with a share's link sees its page and can download the data behind each card from its data URLs, with no key. Share only data you would publish.

The blocks on this page run in order, as cells of one notebook.

## Make cards and publish a share

A card draws one version of one Dataset, every series it holds, so narrow the rows first. Make a line chart and a headline number of German aid per person in Kenya, then publish both:

```text
Card(line cmp_01M6292M9NTCMEE39WWMRRJXKZ, "German aid per person in Kenya", 1 series, draws ops_0fe63aa61ade066c970f174bf2392339 at ocv_129d9b2f36f398bb414c5f7a97230804)
Card(stat cmp_01M6292MB9ZN8GGHMP87CHF20A, "Change since 2018", 1 series, draws ops_0fe63aa61ade066c970f174bf2392339 at ocv_129d9b2f36f398bb414c5f7a97230804)
Share(live https://developmentfinance.org/s/7NHGA70g, 2 slots, revision 1)
https://developmentfinance.org/s/7NHGA70g
https://developmentfinance.org/embed/7NHGA70g
```

```python
import dfo

aid = dfo.search("ODA from Germany to Kenya, Ghana and Nigeria, 2018 to 2023").fetch()
people = dfo.search("Kenya population, 2015 to 2024").fetch()
per_person = dfo.analysis.quotient_of(aid, people, on={"destination": "place"})

line = dfo.cards.line(per_person, title="German aid per person in Kenya")
stat = dfo.cards.stat(
    per_person, year=2023, compare_to=2018, change="percent", title="Change since 2018"
)
print(line)
print(stat)

share = dfo.share([line, stat], latest=True)
print(share)
print(share.url)
print(share.embed_url)
```

Each card takes a slot, numbered from 1 in the order given. `share.url` is the page, `share.embed_url` the same cards for an iframe, and `share.data_urls` holds one download link per slot.

`latest` has no default, because it decides what the link shows over time:

- `latest=True` makes a live share. Each card follows new data. A card of a Dataset fetched from a Spec or a recipe draws the newest version each time DFO publishes one, and a window of `dfo.latest_year(...)` moves with it. A live share also takes new cards under the same link.
- `latest=False` makes a snapshot. Each card keeps the version it draws today, for good.

Each caller has a daily allowance of cards. Once it is spent, `dfo.cards` raises `QuotaExceededError` (`allowance_exhausted`) with `retry_after`, the seconds until it resets.

`dfo.cards` has five kinds:

| Function                                                                  | Draws                                                            |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `line(data, window=None, title=None)`                                     | One line per series over time                                    |
| `bar(data, window=None, title=None)`                                      | Bars that compare the series' members or the years               |
| `table(data, window=None, title=None)`                                    | Every series over the years                                      |
| `stat(data, year=None, compare_to=None, change="difference", title=None)` | One value of a single series, with its change since `compare_to` |
| `source(data)`                                                            | The source, licence, dates, and citation of the data             |

`window` takes `(start, end)`, each a year or a `dfo.latest_year(offset)`. A stat card's `change="difference"`, the default, is the shown value minus the earlier one, in the data's unit. `change="percent"` is that difference as a percentage of the earlier value: 25.0 is a 25% rise. Without a title, DFO writes one from the data.

## Keep the write token

DFO gives a share's write token, `shw_…`, once, in the reply that makes the share. The client keeps it on the `Share` as `share.write_token` and leaves it out of the repr. Changing or taking down the share later needs it, so store it beside the URL, somewhere private:

```python
import json
from pathlib import Path

Path("share.json").write_text(
    json.dumps({"url": share.url, "write_token": share.write_token})
)
```

Anyone with the token can change the share or take it down. A lost token cannot be recovered, and the share stays up.

## Replace the cards of a live share

`dfo.share(cards, latest=True, replace=share)` puts new cards on a live share under the same URLs, and raises its revision:

```text
Share(live https://developmentfinance.org/s/7NHGA70g, 2 slots, revision 2)
```

```python
recent = dfo.cards.table(
    per_person,
    window=(dfo.latest_year(-2), dfo.latest_year()),
    title="German aid per person in Kenya, last three years",
)
share = dfo.share([recent, stat], latest=True, replace=share)
print(share)
```

A `Share` carries its token. In a later session, pass the URL and the stored token:

```python
saved = json.loads(Path("share.json").read_text())
share = dfo.share(
    [recent, stat], latest=True, replace=saved["url"], write_token=saved["write_token"]
)
```

`replace` takes a `Share` or the URL of its page or embed. A snapshot cannot be replaced. `replace` with `latest=False` raises `InvalidRequestError` before any request, and DFO refuses a snapshot's URL with `share_not_replaceable`. A replace with fewer cards leaves the later slots empty. Their data URLs answer not found, and `dfo.fetch(share, slot=n)` of an empty slot raises `NotFoundError`.

## Fix a live share as a snapshot

`dfo.snapshot(share)` turns a live share into a snapshot under the same URLs. Each slot keeps the version it shows now:

```text
Share(snapshot https://developmentfinance.org/s/7NHGA70g, 2 slots, revision 4)
```

```python
share = dfo.snapshot(share)
print(share)
```

It sends the share's own token, or the one passed as `write_token=`.

## Get what a share showed on a date

`dfo.fetch(share)` returns the Dataset a slot shows now, `dfo.history(share)` lists what each slot has served, and `dfo.fetch(share, as_of=...)` returns what a slot showed on a past date. Pass `slot=` when the share has more than one:

```text
<Dataset Computed by DFO: quotient_of.
  Source: OECD DAC2A; World Development Indicators
  Derived: quotient_of by financingRecipient, from 2 readings
  Missing data: 3 series left out · data.left_out
  Shown by: share 7NHGA70g, slot 1 "German aid per person in Kenya, last three years", on 28 October 2026
  Version: ocv_129d9b2f36f398bb414c5f7a97230804 (exact), pinned
  Rows: 6, time_period as text, such as "2022" or "2021/2022"
  Keep: data.save(path) · newest later: dfo.fetch(data.ref, latest=True)>
Served(slot 1 cmp_01M6291ENV6KNJHFWJHWNR7JD9 from 28 Oct 2026: ops_0fe63aa61ade066c970f174bf2392339 at ocv_129d9b2f36f398bb414c5f7a97230804 · fetchable)
```

```python
import datetime

shown = dfo.fetch(share, slot=1)
print(shown)

for served in dfo.history(share):
    print(served)

today = dfo.fetch(share.url, slot=1, as_of=datetime.date.today())
```

`as_of` takes a `date`, read as the end of that day in UTC, a `datetime`, read as UTC when it has no time zone, or ISO text such as `"2026-10-28"`. The fetch returns the version the slot first served on or before that moment, and raises `InvalidRequestError` when the slot served nothing by then. Without `as_of`, it returns the version the slot shows now. The repr's `Shown by` line names the share, the slot, the card's title, and the day.

`dfo.history(share)` lists every version each slot served, newest first, as `Served` entries, and needs no token. A slot's entry appears once the share serves it, when a page, an embed, or a fetch first reads the slot. An entry marked `fetchable` can still be fetched. Each version a share serves is pinned, so it stays fetchable while the share is up. When a replace leaves a slot without a card, `history` adds an entry for that slot with `card_id`, `card_revision`, `spec_id`, and `content_version` all `None`, and `fetch(share, slot=n, as_of=...)` raises `NotFoundError` for a moment after it, until a later replace fills the slot.

A share fetch reads the frame layout, and refuses `window`, `entities`, `facets`, `party_totals`, `latest=True`, and any other layout, before any request.

## Take a share down

`dfo.unshare(share)` takes the link down. Pass a URL with its stored token:

```python
dfo.unshare(saved["url"], write_token=saved["write_token"])
```

Taking a share down again with its token succeeds, so a retry after a lost reply is safe. After that, `dfo.history` and `dfo.fetch` of the share raise `NotFoundError`.

## Reference

### `dfo.cards`

`client.cards` on a `Client` or `AsyncClient` has the same methods. Each returns a `Card`.

| Name     | Signature                                                                       |
| -------- | ------------------------------------------------------------------------------- |
| `line`   | `line(data, /, *, window=None, title=None)`                                     |
| `bar`    | `bar(data, /, *, window=None, title=None)`                                      |
| `table`  | `table(data, /, *, window=None, title=None)`                                    |
| `stat`   | `stat(data, /, *, year=None, compare_to=None, change="difference", title=None)` |
| `source` | `source(data, /)`                                                               |

`data` takes a `Dataset` or a `DatasetRef` of one version, a dataset version or a derived one. These raise `InvalidRequestError` (`invalid_argument`) before any request: a `Spec`, a `Recipe`, or text, which you fetch first; a Dataset of several members; a Dataset with no rows; `compare_to` without `year`; and `change` without `compare_to`. `change` takes `"difference"` or `"percent"`.

### `Card`

`dfo.types.Card`: `id` (`cmp_…`), `revision`, `kind` (`line`, `bar`, `table`, `stat`, or `source`), `ref`, the version it draws, `title`, `held_until`, `pinned`, and `write_token` (`cmw_…`, left out of the repr).

### `dfo.share`

`dfo.share(cards, /, *, latest, replace=None, write_token=None) -> Share`, also `client.share`. `cards` takes a `Card` or a list of them. `replace` takes a live `Share` or its URL, and needs `latest=True`. `write_token` goes with `replace` only, and wins over the `Share`'s own.

### `dfo.snapshot`, `dfo.unshare`, `dfo.history`

- `dfo.snapshot(share, /, *, write_token=None) -> Share`
- `dfo.unshare(share, /, *, write_token=None) -> None`
- `dfo.history(share, /) -> tuple[Served, ...]`

Each takes a `Share` or the URL of its page or embed, as `https://developmentfinance.org/s/7NHGA70g`. A bare share id raises `InvalidRequestError`. `snapshot` and `unshare` send `write_token`, else the `Share`'s own token.

### `Share`

`dfo.types.Share`: `id`, `url`, `embed_url`, `data_urls`, one per slot, `revision`, `latest`, True for a live share, and `write_token`, left out of the repr.

### `Served`

`dfo.types.Served`, an entry of `dfo.history`: `slot`, `card_id`, `card_revision`, `spec_id`, `content_version`, all `None` for a slot left without a card, `first_served`, a UTC `datetime`, `pinned`, `held_until`, and `fetchable`.

### Fetching a share

`dfo.fetch(target, /, *, as_of=None, slot=None, strict=False, timeout=None, progress=None)` with a `Share` or its URL. `slot` counts from 1 and may be left out for a share of one slot. `as_of` takes a `date`, a `datetime`, or ISO text.

### Errors

| Code                    | Class                   | Raised when                                                           |
| ----------------------- | ----------------------- | --------------------------------------------------------------------- |
| `write_token_required`  | `InvalidRequestError`   | A change to a share carried no token                                  |
| `write_token_invalid`   | `PermissionDeniedError` | The token is not the share's                                          |
| `share_not_replaceable` | `InvalidRequestError`   | `replace` names a snapshot                                            |
| `allowance_exhausted`   | `QuotaExceededError`    | The day's share allowance is spent; `retry_after` says when it resets |
| `not_found`             | `NotFoundError`         | No share has that id, or it was taken down                            |

## Next

- [Compute a figure on DFO](compute.md) makes the derived results cards draw.
- [Errors](errors.md) lists every code a share call can raise.
