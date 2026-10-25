# Answers and choices

`dfo.search(question)` returns an `Answer`, which says what Search understood the question to ask, part by part. An answer holds readings and no data. Print it to see Search's sentence and the line to type next. `answer.fetch()` builds the data when every part has a reading, and stops before any build when one does not.

The blocks on this page run in order, as cells of one notebook.

## Read an answer

A question can ask for several things. "GDP of Kenya and health spending" has two parts, and Search gives one sentence covering both:

```text
Kenya's GDP, 1960 to 2025. Current US dollars · World Development Indicators. Kenya's health expenditure per capita in international dollars, 2000 to 2023. World Development Indicators.
  Fetch: answer.fetch()
```

```python
import dfo

answer = dfo.search("GDP of Kenya and health spending")
print(answer)
print(answer.complete)  # True: every part has a reading
print(len(answer.specs))  # 2: one spec per distinct reading
```

`answer.fetch()` builds each reading once and stacks them into one long table, with a `part` column that names the part each row answers.

| Attribute   | Holds                                                                           |
| ----------- | ------------------------------------------------------------------------------- |
| `sentence`  | Search's sentence for the whole answer; None for a declined or catalogue answer |
| `parts`     | One part per variable asked, in the question's order                            |
| `specs`     | The readings, one per distinct spec                                             |
| `complete`  | Whether every part has a reading                                                |
| `gaps`      | The parts that stop a complete dataset, each a `Gap`                            |
| `kind`      | `resolution`, `catalogue` or `declined`                                         |
| `reason`    | Why Search declined, for a declined answer                                      |
| `warnings`  | Search's warnings for the whole answer                                          |
| `timed_out` | Whether Search stopped at its time limit                                        |
| `trace_id`  | The Search response's trace id; quote it when you report a reading              |

In a notebook the answer renders as HTML with the same content.

## Choose a reading

When a part has several readings, the answer lists them, numbered from 0, and ends with the line that settles it. "GDP of Kenya and government education spending in Kenya" has one answered part and one with two readings:

```text
Answered 1 of 2 parts of your question.
  answered "GDP": Kenya's GDP, 1960 to 2025. Current US dollars · World Development Indicators.
  missing  "government education spending": 2 readings
    [0] Kenya's percent of nominal GDP spent on education, 1971 to 2024 · World Development Indicators
    [1] Kenya's percent of total government expenditure on education, 1980 to 2025 · World Development Indicators
  Choose: answer.choose(0).fetch()
  Or take the answered part: answer.fetch(partial=True)
```

`answer.choose(option)` picks in the only part that awaits a choice. `answer.choose(option, part=...)` names the part, by its index or its words in the question. The option is its index, its label, or its whole line as the list prints it, such as `"Kenya's percent of nominal GDP spent on education, 1971 to 2024 · World Development Indicators"`. A closing full stop makes no difference, and a line copied from the TypeScript client's printout works too:

```python
answer = dfo.search("GDP of Kenya and government education spending in Kenya")
print(answer)

chosen = answer.choose(0, part="government education spending")
data = chosen.fetch()
print(data)
print(data.to_pandas()["part"].value_counts())
```

```text
<Dataset Kenya's GDP, 1960 to 2025. Current US dollars · World Development Indicators. Kenya's percent of nominal GDP spent on education, 1971 to 2024. World Development Indicators.
  Source: World Development Indicators
  Versions: cv_00f3d36b33447b0675e100ebc84120ee, cv_fae9479e51caadfe190a62b9e629c202 (exact), held until 24 November 2026, not pinned
  Rows: 109
  Keep: data.save(path) · newest later: dfo.fetch(data.ref, latest=True)>
part
GDP                              66
government education spending    43
Name: count, dtype: int64
```

A choice makes one Search request, which runs no language model. The new answer, its sentence and its "Assumed: ..." clause are Search's. `choose` raises `InvalidRequestError` with the code `choice_invalid` when no part awaits a choice, several do and none is named, or the part or option is unknown. The message lists the valid choices.

The order of readings can change between searches. The run above lists the share of GDP first, and another run of the same question can list it second. In a script that runs again later, keep `data.ref` from the dataset you built and fetch that. [Datasets and versions](datasets.md) covers refs.

Each reading is also a spec you can fetch on its own, without a new search:

```python
answer = dfo.search("government education spending Kenya")
candidate = answer.parts[0].candidates[1]
print(candidate.label, "·", candidate.source)

data = dfo.fetch(candidate.spec)
print(len(data))
```

### A place that matches several

"Congo" names two countries. The part has no reading, and its options are the places it could mean:

```text
Answered 0 of 1 part of your question.
  missing  "GDP": "Congo" matches more than one entity: "Congo [DRC]" and "Congo [Republic]". Be more specific.
    [0] Congo [DRC]
    [1] Congo [Republic]
  Choose: answer.choose("Congo [DRC]").fetch()
```

```python
answer = dfo.search("GDP of Congo")
print(answer)

chosen = answer.choose("Congo [DRC]")
print(chosen)
```

```text
Democratic Republic of the Congo's GDP, 1960 to 2025. Current US dollars · World Development Indicators.
  Note: no time_text was given; the answer was resolved across every period with data.
  Fetch: answer.fetch()
```

The choice searches again with that place pinned. Whether Search asks or picks a country for you depends on the wording, so a script that cannot stop to ask uses the full name, "GDP of the Democratic Republic of the Congo". [Look up a place code](../README.md#look-up-a-place-code) lists every place a name matches. A question can repeat a wording, as "aid from Congo to Congo" does, so each place `Option` carries `entity_choice`, the number of the wording it settles, and a menu groups options by it.

## Take the answered parts

`fetch(partial=True)` builds the parts that have a reading and lists the rest in `data.missing`. In "debt service of Kenya and the price of tea in Kenya", Search finds no indicator for the price of tea:

```text
<Dataset Kenya's external debt service owed to all creditors, 1970 to 2024. Current US dollars · World Bank International Debt Statistics (IDS).
  Source: World Bank International Debt Statistics (IDS)
  Version: cv_2c981b422e8f8bdf5dee6067837cff13 (exact), pinned
  Rows: 55
  Incomplete: 1 part(s) left out
  Keep: data.save(path) · newest later: dfo.fetch(data.ref, latest=True)>
```

```python
answer = dfo.search("debt service of Kenya and the price of tea in Kenya")
data = answer.fetch(partial=True)
print(data)

for gap in data.missing:
    print(gap.kind, gap.message)
```

The file `data.save` writes keeps the gaps, and `dfo.load` reads them back. `to_pandas().attrs["missing"]` holds each gap's kind and message. `fetch(partial=True)` raises `IncompleteAnswerError` when no part has a reading.

Leave `partial` off in a scheduled job. A question that resolved in full this month can come back half-answered next month, and the job then stops with a message where it would have published half the data.

## When the reading differs from the question

Search fetches published figures and computes nothing on top. "top 5 donors to Ethiopia in 2022" returns the amounts for every donor, and the answer lists what it did not do under its sentence:

```text
Gross disbursements to Ethiopia from 110 providers for official development assistance in 2022. Current US dollars · OECD DAC2a. You asked for a ranking. This shows the amounts behind it, because Search does not compute rankings. Assumed: official development assistance.
  Not done: rank ("top 5 donors")
  Note: The answer covers official development assistance of every aid type.
  Note: no provider was named; the answer was resolved across every provider with data.
  Fetch: answer.fetch()
```

`fetch` builds the data and issues one `SearchWarning` that repeats these lines. The dataset keeps the skipped steps in `requested_operations`, so the ranking is yours to compute:

```python
import warnings

answer = dfo.search("top 5 donors to Ethiopia in 2022")
print(answer)

with warnings.catch_warnings():
    warnings.simplefilter("ignore", dfo.errors.SearchWarning)
    data = answer.fetch()

for operation in data.requested_operations:
    print(operation.verb, operation.phrase)  # rank top 5 donors

df = data.to_pandas()
top = df.groupby("financingProvider_label")["value"].sum().nlargest(5)
print(top)
```

```text
financingProvider_label
International Development Association    1.493235e+09
United States of America                 1.449632e+09
Germany                                  2.525215e+08
European Union institutions              2.398839e+08
Global Fund                              2.120871e+08
Name: value, dtype: float64
```

The table leaves out group and total rows, such as "DAC countries", so the ranking compares single donors. `fetch(party_totals=True)` keeps them, with `financingProvider_kind` set to `total` or `whole total`.

`fetch(strict=True)` raises the `SearchWarning` where `fetch` would issue it, and does the same for the dataset's own warnings. Use it where a reading that differs from the question should stop the run:

```python
try:
    answer.fetch(strict=True)
except dfo.errors.SearchWarning as warning:
    print(warning)
```

## Share an answer

`answer.to_json()` writes the question and Search's response as JSON. `dfo.Answer.from_json(text)` reads it back into an answer that chooses and fetches as the first one did, through the default client or the one you pass as `client=`:

```python
answer = dfo.search("government education spending Kenya")
text = answer.to_json()

restored = dfo.Answer.from_json(text)
print(restored == answer)  # True
data = restored.choose(1).fetch()
print(data.sentence)
```

A web app uses this to show the readings on one request and build the reader's choice on the next. The JSON is plain data, and a browser can edit it before posting it back, so the answer can carry any reading and its builds run on your key. With a public-tier key that costs quota, so rate-limit the routes per visitor. With a key beyond the public tier, keep the JSON on the server under a random id the page sends back, or sign it before it leaves. The TypeScript client reads the same JSON with `Answer.fromJSON`.

## Declined and catalogue answers

Search declines a question that asks for an argument and names no data, and answers "what data do you have?" with the catalogue. Both answers have no parts, and `fetch` raises `DeclinedError` with the code `answer_declined`:

```python
answer = dfo.search("should donors give more aid to Kenya?")
print(answer.kind, answer.reason)  # declined requires_analysis

try:
    answer.fetch()
except dfo.errors.DeclinedError as error:
    print(error)
```

```text
Search declined the question: it asks for an argument and names no data to show.
  Next: ask for a figure DFO publishes; dfo.lookup.catalogue() lists example questions.
[answer_declined · trace ebc1967a88fb4655a42b421f736a425e]
```

`print(answer)` shows the same two lines. A catalogue answer's next line names `dfo.lookup.catalogue()` too.

`dfo.lookup.catalogue()` returns what Search holds data on, with counts and example questions. `place=` scopes it to one country:

```python
catalogue = dfo.lookup.catalogue(place="country/KEN")
for example in catalogue["examples"][:3]:
    print(example["text"])
```

```text
ODA to Kenya since 2015
Emergency response aid to Kenya
PPG external debt service of Kenya
```

## Gap kinds

`answer.gaps` and `IncompleteAnswerError.gaps` hold one `Gap` per part without a reading, with its `part_index`, `part`, `kind`, `message` and `options`. A part with several readings offers its candidates as options, and a place that matches several offers one `Option` per place.

| `kind`           | What it means                                                     | What to do                              |
| ---------------- | ----------------------------------------------------------------- | --------------------------------------- |
| `choice`         | Several readings, or a place or source that matches several       | `answer.choose(option, part=...)`       |
| `no_data`        | Understood, and DFO holds no data for it                          | Ask for other years, places or measures |
| `not_understood` | Search could not match a word to a measure, place, source or unit | Reword the part                         |
| `unsupported`    | Understood, and outside what DFO answers                          | Ask a different question                |
| `timed_out`      | Search reached its time limit before the part resolved            | Search again, or ask for less at once   |
| `unknown`        | A part status this client does not know                           | Upgrade `development-finance`           |

## Part classes

Each part is one of five classes in `dfo.types`, and each matches on its main field:

```python
from dfo import types

answer = dfo.search("government education spending Kenya")

for part in answer.parts:
    match part:
        case types.DefinitePart(spec):
            print("reading:", spec.sentence)
        case types.CandidatesPart(candidates):
            for index, candidate in enumerate(candidates):
                print(f"[{index}]", candidate.label)
        case types.NoDataPart(reason) | types.UnsupportedPart(reason):
            print(reason, part.message)
        case _:
            print("a status this client does not know:", part.status)
```

- `DefinitePart(spec)` has one reading.
- `CandidatesPart(candidates)` has several, in the server's order. Each `Candidate` has a `spec`, `sentence`, `label`, `source`, `unit` and `assumptions`. `truncated` is True when the server left readings out.
- `NoDataPart(reason)` has no reading. `reason` is a code such as `variable_not_resolved` or `entity_ambiguous`, `message` is the server's explanation, and `options` holds the places or sources that would settle it.
- `UnsupportedPart(reason)` was understood and is outside what DFO answers.
- `UnknownPart(status, raw)` has a status newer than this client. Upgrade `development-finance` to read it.

Every part also carries `variable_text` (the question's words for it), `sentence`, `departures`, `operations`, `assumptions` and `warnings`. Each `Assumption` is a choice Search made that the question left open, such as the aid type, with its `kind`, `binding_ref`, `text` and `refs`. The sentence states them in its "Assumed: ..." clause.

## Next

- [Datasets and versions](datasets.md): what `fetch` returns, and how to get the same rows back later.
- [Errors](errors.md): `IncompleteAnswerError`, `DeclinedError` and the rest, by what you do next.
