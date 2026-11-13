/**
 * Cards: charts, tables, headline numbers and source notes DFO stores and draws.
 *
 * Each call posts one intent to `POST /presentation/components` and returns the `Card` DFO
 * stored. A card draws the frame of one exact version: the version a Dataset holds, a derived
 * frame included, or the one a `DatasetRef` names. It draws every series of that version, since
 * its `select` binds `stat_var` to the variables the version holds and leaves every other
 * dimension open; narrow the rows with `client.analysis.filter` first. A Dataset's variables are
 * read from its `stat_var` column. A ref's, and those of a Dataset without that column, are read
 * from `GET /presentation/frames/{spec_id}/{version}?dimension=stat_var`, one request more.
 *
 * A window is `{start, end}`, each side a year as text or a latest year as
 * `{anchor: "latest", offset}`, which DFO settles each time the card is drawn. A stat card shows
 * the value of one year, so it sends `year` as both ends of its window; with `compareTo` its
 * window runs from `compareTo` to `year`, and its `change` names those two years as its basis.
 *
 * The create carries a `cmw_` write token the client mints, which makes a retry of the same
 * create answer the first card instead of storing a second one.
 */

import { Dataset, datasetTable } from "./dataset.ts";
import { columnValues } from "./parquet.ts";
import { CARD_TYPES, readCard } from "./publication.ts";
import type { Card, CardKind } from "./publication.ts";
import { Recipe } from "./recipe.ts";
import type { Year } from "./recipe.ts";
import { clientError } from "../core/errors.ts";
import type { InvalidRequestError } from "../core/errors.ts";
import { isRecord } from "../core/json.ts";
import { checkOptions, declareOptions } from "../core/options.ts";
import { periodObject } from "../core/periods.ts";
import { quoted, trimEnd } from "../core/text.ts";
import { DatasetRef } from "../core/ref.ts";
import { describing } from "../core/trace.ts";
import type { Transport } from "../http/transport.ts";

const CARDS_PATH = "/presentation/components";
/** The column every frame names its variable in. */
const STAT_VAR = "stat_var";

/** A line, bar or table card's options. */
export type CardOptions = {
  /** The first and last years drawn, such as `[latestYear(-9), latestYear()]`, which DFO
   *  settles each time the card is drawn; none draws every year. */
  window?: readonly [start: Year, end: Year];
  /** The card's title; none lets DFO title it. */
  title?: string;
};

/** How a stat card works out its change since `compareTo`: `percent`, the difference as a
 *  percentage of the earlier year's value, where 25 is a 25% rise; or `difference`, the shown
 *  value minus the earlier, in the data's unit. */
export type StatChange = "percent" | "difference";

/** A stat card's options. */
export type StatOptions = {
  /** The year shown, such as `latestYear()`; none shows the newest year the series holds. */
  year?: Year;
  /** The year the change counts from, such as `latestYear(-1)`; none shows no change. */
  compareTo?: Year;
  /** `difference` by default, the shown value minus the earlier, in the data's unit; `percent`
   *  is that difference as a percentage of the earlier value, where 25 is a 25% rise. */
  change?: StatChange;
  /** The card's title; none lets DFO title it. */
  title?: string;
};

const CARD_OPTIONS = declareOptions<CardOptions>("cards", { window: true, title: true });
const STAT_OPTIONS = declareOptions<StatOptions>("cards.stat", {
  year: true,
  compareTo: true,
  change: true,
  title: true,
});

/** A stat card's `change` words, in the card schema's derivations: `difference` is its
 *  default, which the intent leaves out. */
const STAT_DERIVATIONS: Readonly<Record<StatChange, string | null>> = {
  difference: null,
  percent: "percent_change",
};

/**
 * Stores a card of `kind` drawing `data`, with the intent's other members.
 *
 * @throws {InvalidRequestError} `data` is not a Dataset or ref of one version with rows
 *   (`invalid_argument`), and no request is sent; or DFO refused the intent.
 * @throws {NotFoundError} The version's frame has aged out (`frame_unavailable`).
 * @throws {QuotaExceededError} The daily card allowance is spent (`allowance_exhausted`);
 *   `retryAfterMs` says when it resets.
 */
async function createCard(
  transport: Transport,
  kind: CardKind,
  data: unknown,
  intent: Readonly<Record<string, unknown>>,
): Promise<Card> {
  const ref = oneVersion(data);
  const deadline = transport.callDeadline();
  const [member] = ref.members;
  const frame = { spec_id: member!.spec.spec_id, content_version: member!.contentVersion };
  const body: Record<string, unknown> = { type: CARD_TYPES[kind], frame_ref: frame, ...intent };
  if (kind !== "source") {
    body["select"] = { [STAT_VAR]: await variables(transport, data, frame, deadline) };
  }
  const response = await transport.request({
    path: CARDS_PATH,
    json: { intent: body, write_token: mintToken("cmw_") },
    deadline,
  });
  return describing(response.traceId, () =>
    readCard(response.body, `POST ${CARDS_PATH}`, kind, ref),
  );
}

/** A write token as DFO mints one: `prefix` and 16 random bytes in unpadded URL-safe base64,
 *  as Python's `prefix + secrets.token_urlsafe(16)`. */
export function mintToken(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const base64 = btoa(String.fromCharCode(...bytes));
  return prefix + trimEnd(base64.replace(/\+/g, "-").replace(/\//g, "_"), "=");
}

/** The ref of the one version `data` holds. */
function oneVersion(data: unknown): DatasetRef {
  if (data instanceof Dataset) {
    if (data.rowCount === 0) throw invalid("The Dataset holds no rows, so a card draws nothing.");
    data = data.ref;
  }
  if (!(data instanceof DatasetRef)) {
    throw invalid(
      `A card draws a Dataset or a DatasetRef of one version, not ${described(data)}; fetch it ` +
        "first with client.fetch(...).",
    );
  }
  if (data.members.length !== 1) {
    throw invalid(
      `A card draws one reading, and this one holds ${data.members.length}; fetch one with ` +
        "client.fetch(new DatasetRef([data.ref.members[0]])).",
    );
  }
  return data;
}

/** What a value that is neither a Dataset nor a ref is, for a refusal. */
function described(value: unknown): string {
  if (value instanceof Recipe) return "a Recipe";
  if (isRecord(value) && typeof value["spec_id"] === "string") return "a spec";
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return `a ${typeof value}`;
}

/** The variables the version holds, from a Dataset's rows when they name them, else from DFO:
 *  one as text, several as a sorted list, so one set of variables always sends one select. */
async function variables(
  transport: Transport,
  data: unknown,
  frame: { spec_id: string; content_version: string },
  deadline: number,
): Promise<string | string[]> {
  let found: string[];
  if (data instanceof Dataset && data.columns.includes(STAT_VAR)) {
    const values = await columnValues(datasetTable(data), STAT_VAR);
    found = values.filter((value): value is string => typeof value === "string");
  } else {
    const path = `/presentation/frames/${frame.spec_id}/${frame.content_version}`;
    const response = await transport.request({ path, query: { dimension: STAT_VAR }, deadline });
    const values = isRecord(response.body) ? response.body["values"] : undefined;
    if (!Array.isArray(values)) {
      throw clientError("contract_violation", {
        detail: `GET ${path} answered no list of the frame's variables.`,
        pointer: "/values",
        traceId: response.traceId,
      });
    }
    found = values.filter((value): value is string => typeof value === "string");
  }
  const sorted = [...new Set(found)].sort();
  const [first, ...others] = sorted;
  if (first === undefined) throw invalid("The version names no variable, so a card draws nothing.");
  return others.length === 0 ? first : sorted;
}

/**
 * A card's `[firstYear, lastYear]` as its intent's window.
 *
 * @throws {InvalidRequestError} `window` is not a pair of years (`invalid_argument`).
 */
function cardWindow(window: unknown): Record<string, unknown> {
  if (!Array.isArray(window) || window.length !== 2) {
    throw invalid(
      `window is [firstYear, lastYear], such as [latestYear(-9), latestYear()], not ${quoted(window)}.`,
    );
  }
  const [start, end] = window as unknown[];
  return { start: periodObject(start, "window"), end: periodObject(end, "window") };
}

function titled(title: unknown): Record<string, unknown> {
  if (title === undefined) return {};
  if (typeof title !== "string" || title.trim() === "") {
    throw invalid("title is non-empty text.");
  }
  return { title };
}

const windowed = (window: unknown): Record<string, unknown> =>
  window === undefined ? {} : { window: cardWindow(window) };

/**
 * A stat card's title, window and change.
 *
 * @throws {InvalidRequestError} `compareTo` is given without `year`, `change` is not a `StatChange`
 *   or is `percent` without `compareTo`, or a year is malformed (`invalid_argument`).
 */
export function statIntent(options: StatOptions): Record<string, unknown> {
  const { year, compareTo, change = "difference", title } = options;
  if (!Object.hasOwn(STAT_DERIVATIONS, change)) {
    throw invalid(`change is "difference" or "percent", not ${JSON.stringify(change)}.`);
  }
  const intent = titled(title);
  if (compareTo === undefined) {
    if (change !== "difference") {
      throw invalid("change needs compareTo, the year the change counts from.");
    }
    if (year !== undefined) {
      const shown = periodObject(year, "year");
      intent["window"] = { start: shown, end: shown };
    }
    return intent;
  }
  if (year === undefined) {
    throw invalid(
      "compareTo needs year, the year the change counts to, such as " +
        "{ year: latestYear(), compareTo: latestYear(-1) }.",
    );
  }
  const start = periodObject(compareTo, "compareTo");
  const end = periodObject(year, "year");
  const derivation = STAT_DERIVATIONS[change];
  const basis = { basis: [start, end], ...(derivation === null ? {} : { derivation }) };
  return { ...intent, window: { start, end }, change: basis };
}

const invalid = (detail: string): InvalidRequestError =>
  clientError("invalid_argument", { detail });

/**
 * Cards DFO stores and draws, each from one Dataset or ref. A card draws every series of the
 * version it is given, so narrow it with `client.analysis.filter` first. A card on its own stays
 * in DFO's 30-day tier; the first share that includes it pins its version.
 */
export class Cards {
  readonly #transport: Transport;

  /** @internal A client builds its own, as `client.cards`. */
  constructor(transport: Transport) {
    this.#transport = transport;
  }

  /** The calls it offers, as `<Cards: line, bar, table, stat, source>`. */
  toString(): string {
    return "<Cards: line, bar, table, stat, source>";
  }

  /** Node's `console.log` and `util.inspect` show it as `String(client.cards)` does. */
  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return this.toString();
  }

  #windowed(kind: CardKind, data: Dataset | DatasetRef, options?: CardOptions): Promise<Card> {
    const { window, title } = checkOptions(CARD_OPTIONS, options);
    return createCard(this.#transport, kind, data, { ...windowed(window), ...titled(title) });
  }

  /**
   * A line chart with one line per series, over time.
   *
   * @throws {InvalidRequestError} `data` holds several versions or no rows, is not a Dataset or
   *   a ref, or an option is malformed (`invalid_argument`), and no request is sent; or DFO
   *   refused the card, such as one whose series vary along two roles.
   * @throws {NotFoundError} The version's frame has aged out (`frame_unavailable`).
   * @throws {QuotaExceededError} The daily card allowance is spent (`allowance_exhausted`);
   *   `retryAfterMs` says when it resets.
   */
  async line(data: Dataset | DatasetRef, options: CardOptions = {}): Promise<Card> {
    return this.#windowed("line", data, options);
  }

  /** A bar chart that compares the series' members or the years. Takes `line`'s options. */
  async bar(data: Dataset | DatasetRef, options: CardOptions = {}): Promise<Card> {
    return this.#windowed("bar", data, options);
  }

  /** A table of every series over the years. Takes `line`'s options. */
  async table(data: Dataset | DatasetRef, options: CardOptions = {}): Promise<Card> {
    return this.#windowed("table", data, options);
  }

  /**
   * One headline value of a single series, with its change since another year, as
   * `client.cards.stat(data, { year: latestYear(), compareTo: latestYear(-1) })`.
   *
   * @throws {InvalidRequestError} `compareTo` is given without `year`, or `change: "percent"`
   *   without `compareTo` (`invalid_argument`), and no request is sent; or DFO refused the
   *   card, such as one whose years hold no value.
   * @throws {QuotaExceededError} The daily card allowance is spent (`allowance_exhausted`);
   *   `retryAfterMs` says when it resets.
   */
  async stat(data: Dataset | DatasetRef, options: StatOptions = {}): Promise<Card> {
    const intent = statIntent(checkOptions(STAT_OPTIONS, options));
    return createCard(this.#transport, "stat", data, intent);
  }

  /**
   * The source, licence, dates and citation of a version's data.
   *
   * @throws {InvalidRequestError} `data` holds several versions or no rows, or is not a Dataset
   *   or a ref (`invalid_argument`), and no request is sent.
   * @throws {QuotaExceededError} The daily card allowance is spent (`allowance_exhausted`);
   *   `retryAfterMs` says when it resets.
   */
  async source(data: Dataset | DatasetRef): Promise<Card> {
    return createCard(this.#transport, "source", data, {});
  }
}
