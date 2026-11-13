# Cards and shares

`client.cards` stores a chart, a table, or a headline number that DFO draws from a dataset, and `client.share` publishes cards under one link that a page or an embed shows.

Cards and shares are public. Anyone with a share's link sees its page and can download the data behind each card from its data URLs, with no key. Share only data you would publish.

The examples on this page form one program. Each block after the first continues it.

## Make cards and publish a share

A card draws one version of one dataset, every series it holds, so narrow the rows first. Make a line chart and a headline number of German aid per person in Kenya, then publish both:

```text
Card(line cmp_01M6292M9NTCMEE39WWMRRJXKZ, "German aid per person in Kenya", 1 series, draws ops_0fe63aa61ade066c970f174bf2392339 at ocv_129d9b2f36f398bb414c5f7a97230804)
Card(stat cmp_01M6292MB9ZN8GGHMP87CHF20A, "Change since 2018", 1 series, draws ops_0fe63aa61ade066c970f174bf2392339 at ocv_129d9b2f36f398bb414c5f7a97230804)
Share(live https://developmentfinance.org/s/7NHGA70g, 2 slots, revision 1)
https://developmentfinance.org/s/7NHGA70g
https://developmentfinance.org/embed/7NHGA70g
```

```ts
import { Client, latestYear } from "@developmentfinance/client";

const client = new Client();
const aid = await (await client.search("ODA from Germany to Kenya, 2018 to 2023")).fetch();
const people = await (await client.search("Kenya population, 2018 to 2023")).fetch();
const perPerson = await client.analysis.quotientOf(aid, people, { on: { destination: "place" } });

const line = await client.cards.line(perPerson, { title: "German aid per person in Kenya" });
const stat = await client.cards.stat(perPerson, {
  year: 2023,
  compareTo: 2018,
  change: "percent",
  title: "Change since 2018",
});
console.log(String(line));
console.log(String(stat));

let share = await client.share([line, stat], { latest: true });
console.log(String(share));
console.log(share.url);
console.log(share.embedUrl);
```

Each card takes a slot, numbered from 1 in the order given. `share.url` is the page, `share.embedUrl` the same cards for an iframe, and `share.dataUrls` holds one download link per slot.

`latest` has no default, because it decides what the link shows over time:

- `latest: true` makes a live share. Each card follows new data. A card of a dataset fetched from a spec or a recipe draws the newest version each time DFO publishes one, and a window of `latestYear(...)` moves with it. A live share also takes new cards under the same link.
- `latest: false` makes a snapshot. Each card keeps the version it draws today, for good.

Each caller has a daily allowance of cards. Once it is spent, `client.cards` raises `QuotaExceededError` (`allowance_exhausted`) with `retryAfterMs`, the milliseconds until it resets.

`client.cards` has five kinds:

| Method                                               | Draws                                                           |
| ---------------------------------------------------- | --------------------------------------------------------------- |
| `line(data, { window?, title? })`                    | One line per series over time                                   |
| `bar(data, { window?, title? })`                     | Bars that compare the series' members or the years              |
| `table(data, { window?, title? })`                   | Every series over the years                                     |
| `stat(data, { year?, compareTo?, change?, title? })` | One value of a single series, with its change since `compareTo` |
| `source(data)`                                       | The source, licence, dates, and citation of the data            |

`window` takes `[start, end]`, each a year or a `latestYear(offset)`. A stat card's `change: "difference"`, the default, is the shown value minus the earlier one, in the data's unit. `change: "percent"` is that difference as a percentage of the earlier value: 25 is a 25% rise. Without a title, DFO writes one from the data.

## Keep the write token

DFO gives a share's write token, `shw_…`, once, in the reply that makes the share. The client keeps it on the `Share` as `share.writeToken` and leaves it out of the text form. Changing or taking down the share later needs it, so store it beside the URL, on your server:

```ts
const stored = JSON.stringify({ url: share.url, writeToken: share.writeToken });
```

Anyone with the token can change the share or take it down. A lost token cannot be recovered, and the share stays up.

## Replace the cards of a live share

`client.share(cards, { latest: true, replace: share })` puts new cards on a live share under the same URLs, and raises its revision:

```text
Share(live https://developmentfinance.org/s/7NHGA70g, 2 slots, revision 2)
```

```ts
const recent = await client.cards.table(perPerson, {
  window: [latestYear(-2), latestYear()],
  title: "German aid per person in Kenya, last three years",
});
share = await client.share([recent, stat], { latest: true, replace: share });
console.log(String(share));
```

A `Share` carries its token. In a later request, pass the URL and the stored token:

```ts
const saved = JSON.parse(stored) as { url: `${string}/s/${string}`; writeToken: string };
share = await client.share([recent, stat], {
  latest: true,
  replace: saved.url,
  writeToken: saved.writeToken,
});
```

`replace` takes a `Share` or the URL of its page or embed. A snapshot cannot be replaced. `replace` with `latest: false` raises `InvalidRequestError` before any request, and DFO refuses a snapshot's URL with `share_not_replaceable`. A replace with fewer cards leaves the later slots empty. Their data URLs answer not found, and `client.fetch(share, { slot: n })` of an empty slot rejects with `NotFoundError`.

## Fix a live share as a snapshot

`client.snapshot(share)` turns a live share into a snapshot under the same URLs. Each slot keeps the version it shows now:

```text
Share(snapshot https://developmentfinance.org/s/7NHGA70g, 2 slots, revision 4)
```

```ts
share = await client.snapshot(share);
console.log(String(share));
```

It sends the share's own token, or the one passed as `writeToken`.

## Get what a share showed on a date

`client.fetch(share)` returns the dataset a slot shows now, `client.history(share)` lists what each slot has served, and `client.fetch(share, { asOf })` returns what a slot showed on a past date. Pass `slot` when the share has more than one:

```text
<Dataset Computed by DFO: quotient_of.
  Source: OECD DAC2A; World Development Indicators
  Derived: quotient_of by financingRecipient, from 2 readings
  Shown by: share 7NHGA70g, slot 1 "German aid per person in Kenya, last three years", on 28 October 2026
  Version: ocv_129d9b2f36f398bb414c5f7a97230804 (exact), pinned
  Rows: 6, time_period as text, such as "2022" or "2021/2022"
  Keep: JSON.stringify(data.ref) · newest later: client.fetch(data.ref, { latest: true })>
Served(slot 1 cmp_01M6291ENV6KNJHFWJHWNR7JD9 from 28 Oct 2026: ops_0fe63aa61ade066c970f174bf2392339 at ocv_129d9b2f36f398bb414c5f7a97230804 · fetchable)
```

```ts
const shown = await client.fetch(share, { slot: 1 });
console.log(String(shown));

for (const served of await client.history(share)) console.log(String(served));

const today = await client.fetch(share.url, { slot: 1, asOf: new Date() });
```

`asOf` takes a `Date` or an ISO string. A date string such as `"2026-10-28"` reads as the last millisecond of that day in UTC. The fetch returns the version the slot first served on or before that moment, and raises `InvalidRequestError` when the slot served nothing by then. Without `asOf`, it returns the version the slot shows now. The text form's `Shown by` line names the share, the slot, the card's title, and the day.

`client.history(share)` lists every version each slot served, newest first, as `Served` entries, and needs no token. A slot's entry appears once the share serves it, when a page, an embed, or a fetch first reads the slot. An entry marked `fetchable` can still be fetched. Each version a share serves is pinned, so it stays fetchable while the share is up. When a replace leaves a slot without a card, `history` adds an entry for that slot with `cardId`, `cardRevision`, `specId`, and `contentVersion` all `null`, and `client.fetch(share, { slot: n, asOf })` throws `NotFoundError` for a moment after it, until a later replace fills the slot.

A share fetch reads the frame layout, and refuses the options that narrow a spec, `partyTotals`, `latest: true`, and any other layout, before any request.

## Take a share down

`client.unshare(share)` takes the link down. Pass a URL with its stored token:

```ts
await client.unshare(saved.url, { writeToken: saved.writeToken });
```

Taking a share down again with its token succeeds, so a retry after a lost reply is safe. After that, `client.history` and `client.fetch` of the share raise `NotFoundError`.

## Reference

### `client.cards`

Each method returns a `Promise<Card>`.

| Method   | Signature                                            |
| -------- | ---------------------------------------------------- |
| `line`   | `line(data, { window?, title? })`                    |
| `bar`    | `bar(data, { window?, title? })`                     |
| `table`  | `table(data, { window?, title? })`                   |
| `stat`   | `stat(data, { year?, compareTo?, change?, title? })` |
| `source` | `source(data)`                                       |

`data` takes a `Dataset` or a `DatasetRef` of one version, a dataset version or a derived one. These raise `InvalidRequestError` (`invalid_argument`) before any request: a spec, a recipe, or a string, which you fetch first; a dataset of several members; a dataset with no rows; `compareTo` without `year`; and `change` without `compareTo`. `change` takes `"difference"` or `"percent"` (`StatChange`).

### `Card`

`id` (`cmp_…`), `revision`, `kind` (`line`, `bar`, `table`, `stat`, or `source`), `ref`, the version it draws, `title`, `heldUntil`, `pinned`, `series`, and `seriesCut`.

### `client.share`

`client.share(cards, { latest, replace?, writeToken? })` returns `Promise<Share>`. `cards` takes a `Card` or an array of them. `replace` takes a live `Share` or its URL, and needs `latest: true`. `writeToken` goes with `replace` only, and wins over the `Share`'s own.

### `client.snapshot`, `client.unshare`, `client.history`

- `client.snapshot(share, { writeToken? })` returns `Promise<Share>`.
- `client.unshare(share, { writeToken? })` returns `Promise<void>`.
- `client.history(share)` returns `Promise<readonly Served[]>`.

Each takes a `Share` or the URL of its page or embed, as `https://developmentfinance.org/s/7NHGA70g`. A bare share id raises `InvalidRequestError`. `snapshot` and `unshare` send `writeToken`, else the `Share`'s own token.

### `Share`

`id`, `url`, `embedUrl`, `dataUrls`, one per slot, `revision`, `latest`, true for a live share, and `writeToken`, left out of the text form.

### `Served`

An entry of `client.history`: `slot`, `cardId`, `cardRevision`, `specId`, `contentVersion`, all `null` for a slot left without a card, `firstServed`, a `Date`, `pinned`, `heldUntil`, and `fetchable`.

### Fetching a share

`client.fetch(share, { asOf?, slot?, strict?, timeout?, signal?, onProgress? })` with a `Share` or its URL. `slot` counts from 1 and may be left out for a share of one slot.

### Errors

| Code                    | Class                   | Raised when                                                            |
| ----------------------- | ----------------------- | ---------------------------------------------------------------------- |
| `write_token_required`  | `InvalidRequestError`   | A change to a share carried no token                                   |
| `write_token_invalid`   | `PermissionDeniedError` | The token is not the share's                                           |
| `share_not_replaceable` | `InvalidRequestError`   | `replace` names a snapshot                                             |
| `allowance_exhausted`   | `QuotaExceededError`    | The day's share allowance is spent; `retryAfterMs` says when it resets |
| `not_found`             | `NotFoundError`         | No share has that id, or it was taken down                             |

## Next

- [Compute a figure on DFO](compute.md) makes the derived results cards draw.
- [Use it in a web app](web-apps.md) keeps the write token on your server.
