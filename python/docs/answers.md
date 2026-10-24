# Answers and choices

`dfo.search(question)` returns an `Answer`: what Search understood the question to ask, part by part. An answer holds readings and no data. `answer.fetch()` builds the data when every part has a reading, and stops before any build when a part lacks one.

Each example on this page runs on its own.

## Read an answer

A question can ask for several things. "GDP of Kenya and health spending" has two parts, and Search resolves each to a reading: a `Spec` that defines one dataset. Printing the answer shows the sentence for each reading:

```text
Kenya's GDP, 1960 to 2025. Current US dollars · World Development Indicators. Kenya's health expenditure per capita in international dollars, 2000 to 2023. World Development Indicators.
```

```python
import dfo

answer = dfo.search("GDP of Kenya and health spending")
print(answer)
print(answer.complete)  # True: every part has a reading
print(len(answer.specs))  # 2: one spec per distinct reading
```

The attributes an answer carries:

| Attribute   | Holds                                                                                        |
| ----------- | -------------------------------------------------------------------------------------------- |
| `sentence`  | Search's sentence for the whole answer; None for a declined or catalogue answer              |
| `parts`     | One part per variable asked, in the question's order                                         |
| `specs`     | The readings, one per distinct spec                                                          |
| `complete`  | Whether every part has a reading                                                             |
| `gaps`      | The parts that stop a complete dataset, each a `Gap`                                         |
| `question`  | The question asked, when the answer came from one                                            |
| `reason`    | Why Search declined, for a declined answer                                                   |
| `kind`      | `resolution`, `catalogue` or `declined`                                                      |
| `status`    | `definite`, `candidates`, `no_data` or `unsupported` when every part shares it, else `mixed` |
| `warnings`  | Search's warnings for the whole answer, as `Notice` objects                                  |
| `timed_out` | Whether Search stopped at its time limit                                                     |
| `trace_id`  | The Search response's trace id; quote it when you report a reading                           |
| `raw`       | The decoded response body, untouched                                                         |

In a notebook the answer renders as HTML with the same content.

## Look at each part

Each part is one of five classes, and each matches by its main field. "government education spending Kenya" has one part with two readings:

```text
[0] Kenya's percent of total government expenditure on education, 1980 to 2025. · World Development Indicators
[1] Kenya's percent of nominal GDP spent on education, 1971 to 2024. · World Development Indicators
```

```python
import dfo

answer = dfo.search("government education spending Kenya")

for part in answer.parts:
    match part:
        case dfo.DefinitePart(spec):
            print("reading:", spec.sentence)
        case dfo.CandidatesPart(candidates):
            for index, candidate in enumerate(candidates):
                print(f"[{index}]", candidate.label, "·", candidate.source)
        case dfo.NoDataPart(reason) | dfo.UnsupportedPart(reason):
            print(reason, part.message)
        case _:
            print("a status this client does not know:", part.status)
```

- `DefinitePart(spec)` has one reading.
- `CandidatesPart(candidates)` has several, in the server's order. Each `Candidate` has a `spec`, `sentence`, `label`, `source`, `unit` and `assumptions`. `truncated` is True when the server left readings out.
- `NoDataPart(reason)` has no reading. `reason` is a code such as `variable_not_resolved` or `entity_ambiguous`, and `message` is the server's explanation.
- `UnsupportedPart(reason)` was understood and is outside what DFO answers.
- `UnknownPart(status, raw)` has a status newer than this client. Upgrade `development-finance` to read it.

Every part also carries `variable_text` (the question's words for it), `departures`, `operations`, `assumptions` and `warnings`. Each `Assumption` is a choice Search made that the question left open, such as the aid type, with its `kind`, `binding_ref`, `text` and `refs`; the sentence states them in an "Assumed: ..." clause.

## Choose a reading

`fetch` raises `IncompleteAnswerError` when a part has several readings. The message lists them and gives the line that settles it:

```text
Search answered 0 of 1 part of your question.
  missing  "government education spending": 2 readings
    [0] Kenya's percent of total government expenditure on education, 1980 to 2025 · World Development Indicators
    [1] Kenya's percent of nominal GDP spent on education, 1971 to 2024 · World Development Indicators
  Choose: answer.choose(0).fetch()
```

`answer.choose(part, option)` settles the part and returns Search's new answer, from one Search request. Name the part by its index or its `variable_text`, and the option by its index or its label:

```python
import dfo

answer = dfo.search("government education spending Kenya")

data = answer.choose("government education spending", 1).fetch()
print(data)
```

When only one part awaits a choice, `answer.choose(option)` picks in that part:

```python
import dfo

answer = dfo.search("government education spending Kenya")
data = answer.choose(0).fetch()
print(data.sentence)
```

When a question has several parts, `fetch` lists each answered part as well, and the message ends with the line that settles the first part awaiting a choice, such as `answer.choose("government education spending", 0).fetch()`.

A pick of a candidate makes one Search request, which runs no language model. It posts the reading's identity back with the assumptions Search made for it, and the new answer's sentence, with its "Assumed: ..." clause, is Search's. In an answer of several parts the request carries every part, so Search composes the joined sentence again. Each candidate also fetches on its own: `candidate.fetch()` asks Search for that reading alone, in one request, and builds the answer Search gives:

```python
import dfo

answer = dfo.search("government education spending Kenya")
candidate = answer.parts[0].candidates[1]
data = candidate.fetch()
print(data.sentence)
```

`choose` raises `InvalidRequestError` with the code `choice_invalid` when no part awaits a choice, several do and none is named, or the part or option is unknown.

> [!WARNING]
> The order of readings can change between searches. Keep `data.ref` from the dataset you built, and leave the index out of any stored record. [Datasets and versions](datasets.md) covers refs.

### A place or source that matches several

A place name such as "Congo" can match two countries. The part is a `NoDataPart` with the reason `entity_ambiguous`, and its gap's kind is `choice`. The gap's `options` are the part's own options, one per place that matches. Choosing one searches again with that place pinned, in one Search request. When the part offers none, ask again with the full name:

```python
import dfo

answer = dfo.search("GDP of Congo")
for gap in answer.gaps:
    print(gap.message)
    if gap.options:
        answer = answer.choose(gap.part_index, gap.options[0].label)
    else:
        answer = dfo.search("GDP of the Democratic Republic of the Congo")
print(answer)
```

Whether Search asks or picks a country for you depends on the wording, so a script handles both answers, as the example does. Each `Option` has a `label` such as "Congo [DRC]" and `mentions`, the words of the question it settles. A word from `mentions` also names the part: `answer.choose("Congo", "Congo [DRC]")`.

## Take the answered parts

`fetch(partial=True)` builds the parts that have a reading and lists the rest in `data.missing`:

```python
import dfo

answer = dfo.search("debt service of Kenya and the price of tea in Kenya")
data = answer.fetch(partial=True)

print(data.complete)  # False
for gap in data.missing:
    print(gap.kind, gap.message)
```

The dataset's display leads with the parts it left out, and the gaps travel with it into `to_pandas().attrs` and the file `save` writes. `fetch(partial=True)` raises `IncompleteAnswerError` when no part has a reading.

A scheduled job should leave `partial` off. A question that resolved in full this month can come back half-answered next month, and the job then stops with a message instead of publishing half the data.

## Gap kinds

`answer.gaps` and `IncompleteAnswerError.gaps` hold one `Gap` per part without a reading, with its `part_index`, `part`, `kind`, `message` and `options`. `kind` is a `dfo.GapKind`, one of the values below. A candidates part's options are its candidates, and a place or source choice's are its `Option`s.

| `kind`           | What it means                                                     | What to do                              |
| ---------------- | ----------------------------------------------------------------- | --------------------------------------- |
| `choice`         | Several readings, or a place or source that matches several       | `answer.choose(part, option)`           |
| `no_data`        | Understood, and DFO holds no data for it                          | Ask for other years, places or measures |
| `not_understood` | Search could not match a word to a measure, place, source or unit | Reword the part                         |
| `unsupported`    | Understood, and outside what DFO answers                          | Ask a different question                |
| `timed_out`      | Search reached its time limit before the part resolved            | Search again, or ask for less at once   |
| `unknown`        | A part status this client does not know                           | Upgrade `development-finance`           |

## When the reading differs from the question

A reading can differ from what was asked. "Top 5 donors to Ethiopia in 2022" returns the amounts for every provider, because Search does not rank. The answer lists what was not done and what was assumed under its sentence:

```text
Gross disbursements to Ethiopia from 137 providers for official development assistance in 2022. Current US dollars · OECD DAC2a. You asked for a ranking. This shows the amounts behind it, because Search does not compute rankings. Assumed: official development assistance.
  Not done: rank ("top 5 donors")
  Note: The answer covers official development assistance of every aid type.
  Note: no provider was named; the answer was resolved across every provider with data.
```

`fetch` builds the data and issues one `SearchWarning` that lists these differences. The dataset keeps them in `departures` and `requested_operations`, so the ranking is yours to compute:

```python
import warnings

import dfo

answer = dfo.search("top 5 donors to Ethiopia in 2022")

with warnings.catch_warnings():
    warnings.simplefilter("ignore", dfo.SearchWarning)
    data = answer.fetch()

for operation in data.requested_operations:
    print(operation.verb, operation.phrase)  # rank top 5 donors

df = data.to_pandas()
donors = df[df["financingProvider_kind"].isin(["official", "private"])]
top = donors.groupby("financingProvider_label")["value"].sum().nlargest(5)
print(top)
```

The provider column also holds totals. `financingProvider_kind` marks "DAC countries" and "Group of Seven" as `total`, and "official donors (DAC)" as `whole total`, the source's figure for every official donor. A single donor reads `official` or `private`. Keep those rows before you rank, or fetch with `without_party_totals=True`, which leaves most of the total rows out. [Datasets and versions](datasets.md#leave-out-party-totals) lists the rows it keeps.

`fetch(strict=True)` raises the `SearchWarning` instead of issuing it, and does the same for the dataset's own warnings. Use it where a reading that differs from the question should stop the run:

```python
import dfo

answer = dfo.search("top 5 donors to Ethiopia in 2022")
try:
    answer.fetch(strict=True)
except dfo.SearchWarning as warning:
    print(warning)
```

## Declined and catalogue answers

Search declines a question that asks for an argument and names no data, and answers "what data do you have?" with the catalogue. Both answers have no parts, and `fetch` raises `DeclinedError` with the code `answer_declined`:

```python
import dfo

answer = dfo.search("should donors give more aid to Kenya?")
print(answer.kind, answer.reason)  # declined requires_analysis

try:
    answer.fetch()
except dfo.DeclinedError as error:
    print(error)
```

`client.catalogue()` returns what Search holds data on, with counts and example questions:

```python
import dfo

with dfo.Client() as client:
    catalogue = client.catalogue(place="country/KEN")
    for example in catalogue["examples"][:3]:
        print(example["text"])
```

## Next

- [Datasets and versions](datasets.md): what `fetch` returns, and how to get the same rows back later.
- [Errors](errors.md): `IncompleteAnswerError`, `DeclinedError` and the rest, by what you do next.
