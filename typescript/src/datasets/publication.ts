/**
 * What cards and shares are: the values `client.cards`, `client.share` and `client.history`
 * return, and how the client reads them from DFO's replies.
 *
 * A `Card` is one chart, table, headline number or source note DFO stores and draws from one
 * frame. A `Share` publishes cards under one `/s/<id>` link, one card per numbered slot: a live
 * share follows new data and takes new cards under the same URLs, and a snapshot keeps the
 * versions its cards drew when it was made. A `Served` is one frame a share's slot served, as
 * `client.history` lists it. `client.fetch(share)` reads the frame a slot shows, which a
 * `ShownFrame` names.
 *
 * A card's and a share's write tokens grant changing them, so each value carries its token as a
 * getter, which `toString`, `util.inspect`, `JSON.stringify` and a spread leave out.
 */

import { dayText } from "./dataset.ts";
import { clientError } from "../core/errors.ts";
import type { ContractError } from "../core/errors.ts";
import { isRecord } from "../core/json.ts";
import type { DatasetRef } from "../core/ref.ts";
import { inline, quoted } from "../core/text.ts";

/** What a card draws: a line chart, a bar chart, a table, a headline number, or the source and
 *  citation of its data. */
export type CardKind = "line" | "bar" | "table" | "stat" | "source";

/** Each card kind's component type in DFO's card catalogue. */
export const CARD_TYPES: Readonly<Record<CardKind, string>> = {
  line: "line_chart",
  bar: "bar_chart",
  table: "table",
  stat: "stat_card",
  source: "source_card",
};

/** A share id as DFO mints it, or keeps it from a website share. */
const SHARE_ID = /^[A-Za-z0-9]{8}$/;
/** The share pages whose last path segment is the share id. */
const SHARE_PAGES = new Set(["s", "embed"]);
/** The longest title a card's text form shows before it cuts it. */
const TITLE_SHOWN_MAX = 60;

/** A card's fields, as the client reads them from a create reply. */
type CardFields = {
  readonly id: string;
  readonly revision: number;
  readonly kind: CardKind;
  readonly ref: DatasetRef;
  readonly title: string | null;
  readonly heldUntil: Date | null;
  readonly pinned: boolean;
  readonly writeToken: string;
};

/** A card DFO stores and draws from one frame. A card on its own stays in DFO's 30-day tier;
 *  the first share that includes it pins the version it draws, which `heldUntil` and `pinned`
 *  do not follow. */
export class Card {
  /** The card's id, `cmp_<...>`. */
  readonly id: string;
  /** The card revision this value names, 1 for a new card. */
  readonly revision: number;
  /** What the card draws. */
  readonly kind: CardKind;
  /** The exact version the card draws, which `client.fetch(card.ref)` reads back. */
  readonly ref: DatasetRef;
  /** The title the card shows, DFO's own when none was given; null for a source card, which
   *  shows no title. */
  readonly title: string | null;
  /** The date the version the card draws stops being guaranteed, 30 days after DFO stored it,
   *  as the create reply stated it, at UTC midnight. Null when pinned, when DFO holds no record
   *  of the version, or while the server does not say. */
  readonly heldUntil: Date | null;
  /** Whether DFO kept that version with no time limit when the card was made. */
  readonly pinned: boolean;
  readonly #writeToken: string;

  /** @internal A card comes from a `client.cards` call. */
  constructor(fields: CardFields) {
    this.id = fields.id;
    this.revision = fields.revision;
    this.kind = fields.kind;
    this.ref = fields.ref;
    this.title = fields.title;
    this.heldUntil = fields.heldUntil;
    this.pinned = fields.pinned;
    this.#writeToken = fields.writeToken;
    Object.freeze(this);
  }

  /** The `cmw_` token that grants revising the card. Keep it as a secret; the text form and
   *  JSON leave it out. */
  get writeToken(): string {
    return this.#writeToken;
  }

  /** The card as `Card(line cmp_…, "title", draws spec_… at cv_…)`. */
  toString(): string {
    const [member] = this.ref.members;
    const title = this.title ? `, "${clipped(this.title)}"` : "";
    return inline(
      `Card(${this.kind} ${this.id}${title}, draws ${member?.spec.spec_id ?? "?"} at ` +
        `${member?.contentVersion ?? "?"})`,
    );
  }

  /** Node's `console.log` and `util.inspect` show the card as `String(card)` does. */
  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return this.toString();
  }
}

/** A share's fields, as the client reads them from a reply. */
type ShareFields = {
  readonly id: string;
  readonly url: string;
  readonly embedUrl: string;
  readonly dataUrls: readonly string[];
  readonly revision: number;
  readonly latest: boolean;
  readonly writeToken: string | null;
};

/** Cards published under one link, each in a numbered slot. */
export class Share {
  /** The share's id, 8 letters and digits. */
  readonly id: string;
  /** The share's page, `/s/<id>`. */
  readonly url: string;
  /** The share's embeddable page, `/embed/<id>`. */
  readonly embedUrl: string;
  /** One JSON data URL per slot, in slot order. A slot keeps its URL when the share's cards are
   *  replaced, so `dataUrls[0]` always reads the first slot. Any page may read them, with no
   *  key. */
  readonly dataUrls: readonly string[];
  /** The share revision this value names, 1 for a new share. */
  readonly revision: number;
  /** True for a live share, which follows new data and takes new cards; false for a snapshot,
   *  which keeps the versions its cards drew when it was made. */
  readonly latest: boolean;
  readonly #writeToken: string | null;

  /** @internal A share comes from `client.share` or `client.snapshot`. */
  constructor(fields: ShareFields) {
    this.id = fields.id;
    this.url = fields.url;
    this.embedUrl = fields.embedUrl;
    this.dataUrls = Object.freeze([...fields.dataUrls]);
    this.revision = fields.revision;
    this.latest = fields.latest;
    this.#writeToken = fields.writeToken;
    Object.freeze(this);
  }

  /** The `shw_` token that grants replacing the share's cards, fixing it as a snapshot and
   *  taking it down. Keep it as a secret on your server; the text form and JSON leave it out.
   *  Null when this value was made without it. */
  get writeToken(): string | null {
    return this.#writeToken;
  }

  /** The share as `Share(live https://…/s/k3Qx8vTa, 1 slot, revision 2)`. */
  toString(): string {
    const mode = this.latest ? "live" : "snapshot";
    const slots = this.dataUrls.length;
    return inline(
      `Share(${mode} ${clipped(this.url)}, ${slots} slot${slots === 1 ? "" : "s"}, ` +
        `revision ${this.revision})`,
    );
  }

  /** Node's `console.log` and `util.inspect` show the share as `String(share)` does. */
  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return this.toString();
  }
}

/** A served frame's fields, as the client reads them from a history reply. */
type ServedFields = {
  readonly slot: number;
  readonly cardId: string;
  readonly cardRevision: number;
  readonly specId: string;
  readonly contentVersion: string;
  readonly firstServed: Date;
  readonly pinned: boolean;
  readonly heldUntil: Date | null;
  readonly fetchable: boolean;
};

/** One frame a share's slot served, as `client.history` lists it. */
export class Served {
  /** The slot that served it, from 1. */
  readonly slot: number;
  /** The card the slot showed. */
  readonly cardId: string;
  /** The card revision the slot showed. */
  readonly cardRevision: number;
  /** The frame's spec id, `spec_<hex>` or `ops_<hex>`. */
  readonly specId: string;
  /** The frame's version, `cv_<hex>` or `ocv_<hex>`. */
  readonly contentVersion: string;
  /** When a read first served the frame. */
  readonly firstServed: Date;
  /** Whether DFO keeps the frame with no time limit. */
  readonly pinned: boolean;
  /** The date an unpinned frame stops being guaranteed, 30 days after DFO stored it; null when
   *  pinned or when DFO holds no record. */
  readonly heldUntil: Date | null;
  /** Whether the frame can still be fetched. */
  readonly fetchable: boolean;

  /** @internal Served frames come from `client.history`. */
  constructor(fields: ServedFields) {
    this.slot = fields.slot;
    this.cardId = fields.cardId;
    this.cardRevision = fields.cardRevision;
    this.specId = fields.specId;
    this.contentVersion = fields.contentVersion;
    this.firstServed = fields.firstServed;
    this.pinned = fields.pinned;
    this.heldUntil = fields.heldUntil;
    this.fetchable = fields.fetchable;
    Object.freeze(this);
  }

  /** The frame as `Served(slot 1 cmp_… from 24 Sep 2026: ops_… at ocv_… · fetchable until 23
   *  Nov 2026)`. */
  toString(): string {
    let keep: string;
    if (!this.fetchable) keep = "no longer fetchable";
    else if (this.pinned || this.heldUntil === null) keep = "fetchable";
    else keep = `fetchable until ${day(this.heldUntil)}`;
    return inline(
      `Served(slot ${this.slot} ${this.cardId} from ${day(this.firstServed)}: ` +
        `${this.specId} at ${this.contentVersion} · ${keep})`,
    );
  }

  /** Node's `console.log` and `util.inspect` show it as `String(served)` does. */
  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return this.toString();
  }
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** A date as `24 Sep 2026`, in UTC, in the same words on every runtime. */
const day = (date: Date): string =>
  `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]!} ${date.getUTCFullYear()}`;

const clipped = (text: string): string =>
  text.length <= TITLE_SHOWN_MAX ? text : `${text.slice(0, TITLE_SHOWN_MAX - 1).trimEnd()}…`;

/** A retention's `held_until` as the UTC midnight of the date it names, or null when it is not
 *  an ISO 8601 date or date-time string. The date is the one the text writes, in its own
 *  offset. */
function heldUntilOf(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const found = /^(\d{4})-(\d{2})-(\d{2})(?:$|T)/.exec(value);
  if (found === null || Number.isNaN(new Date(value).getTime())) return null;
  const [, year, month, date] = found.map(Number) as [number, number, number, number];
  return new Date(Date.UTC(year, month - 1, date));
}

/**
 * The card a create reply names.
 *
 * @throws {ContractError} The reply lacks the card's id, revision or write token
 *   (`contract_violation`).
 */
export function readCard(reply: unknown, route: string, kind: CardKind, ref: DatasetRef): Card {
  const body = object(reply, route, "");
  const { pinned, heldUntil } = retentionOf(body["retention"], route, "/retention");
  return new Card({
    id: textAt(body, "component_id", route),
    revision: countAt(body, "revision", route),
    kind,
    ref,
    title: cardTitle(body),
    heldUntil,
    pinned,
    writeToken: textAt(body, "write_token", route),
  });
}

/** The title a card reply's drawn card shows, or null when it shows none. */
export function cardTitle(body: unknown): string | null {
  const payload = isRecord(body) ? body["resolved_payload"] : undefined;
  const component = isRecord(payload) ? payload["component"] : undefined;
  const title = isRecord(component) ? component["title"] : undefined;
  const text = isRecord(title) ? title["text"] : undefined;
  return typeof text === "string" && text !== "" ? text : null;
}

/**
 * The share a create, replace or snapshot reply names, carrying the reply's write token, else
 * `writeToken`.
 *
 * @throws {ContractError} The reply lacks a member the share is read from
 *   (`contract_violation`).
 */
export function readShare(reply: unknown, route: string, writeToken: string | null): Share {
  const body = object(reply, route, "");
  const dataUrls = body["data_urls"];
  if (
    !Array.isArray(dataUrls) ||
    !dataUrls.every((url): url is string => typeof url === "string" && url !== "")
  ) {
    throw violation(route, "/data_urls", "is not a list of URLs");
  }
  return new Share({
    id: textAt(body, "id", route),
    url: textAt(body, "url", route),
    embedUrl: textAt(body, "embed_url", route),
    dataUrls,
    revision: countAt(body, "revision", route),
    latest: flagAt(body, "latest", route),
    writeToken: "write_token" in body ? textAt(body, "write_token", route) : writeToken,
  });
}

/**
 * The frames a history reply lists, newest first.
 *
 * @throws {ContractError} An entry lacks a member it is read from (`contract_violation`).
 */
export function readHistory(reply: unknown, route: string): readonly Served[] {
  const served = object(reply, route, "")["served"];
  if (!Array.isArray(served)) throw violation(route, "/served");
  return Object.freeze(
    served.map((entry: unknown, index) => {
      const pointer = `/served/${index}`;
      return servedEntry(object(entry, route, pointer), route, pointer);
    }),
  );
}

function servedEntry(entry: Record<string, unknown>, route: string, pointer: string): Served {
  const frame = object(entry["frame"], route, `${pointer}/frame`);
  const { pinned, heldUntil } = retentionOf(entry["retention"], route, `${pointer}/retention`);
  const firstServed = new Date(textAt(entry, "first_served_at", route, pointer));
  if (Number.isNaN(firstServed.getTime())) {
    throw violation(route, `${pointer}/first_served_at`, "is not an ISO 8601 time");
  }
  return new Served({
    slot: countAt(entry, "slot", route, pointer),
    cardId: textAt(entry, "component_id", route, pointer),
    cardRevision: countAt(entry, "revision", route, pointer),
    specId: textAt(frame, "spec_id", route, `${pointer}/frame`),
    contentVersion: textAt(frame, "content_version", route, `${pointer}/frame`),
    firstServed,
    pinned,
    heldUntil,
    fetchable: flagAt(entry, "fetchable", route, pointer),
  });
}

/**
 * Whether a reply's retention pins its frame, and the date an unpinned one is held until. DFO
 * answers null for a frame it holds no record of, and a reply from before retention was stated
 * has none; both read as unpinned with no date.
 *
 * @throws {ContractError} The retention is not an object with a `pinned` flag
 *   (`contract_violation`).
 */
function retentionOf(
  value: unknown,
  route: string,
  pointer: string,
): { pinned: boolean; heldUntil: Date | null } {
  if (value === null || value === undefined) return { pinned: false, heldUntil: null };
  const held = object(value, route, pointer);
  if (flagAt(held, "pinned", route, pointer)) return { pinned: true, heldUntil: null };
  return { pinned: false, heldUntil: heldUntilOf(held["held_until"]) };
}

/**
 * The id of the share `target` names: a `Share`, or the URL of its page or embed, such as
 * `https://developmentfinance.org/s/k3Qx8vTa`, on any host, with a trailing slash or a query
 * allowed; null when it is neither.
 */
export function shareIdIn(target: unknown): string | null {
  if (target instanceof Share) return target.id;
  if (typeof target !== "string") return null;
  const path = URL.parse(target, "http://share.invalid/")?.pathname ?? "";
  const segments = path.replace(/\/+$/, "").split("/");
  const [page, id] = segments.slice(-2);
  return segments.length >= 2 && SHARE_PAGES.has(page ?? "") && SHARE_ID.test(id ?? "")
    ? id!
    : null;
}

/**
 * The id of the share `target` names, as `shareIdIn` reads it.
 *
 * @throws {InvalidRequestError} `target` names no share (`invalid_argument`).
 */
export function shareIdOf(target: unknown): string {
  const id = shareIdIn(target);
  if (id !== null) return id;
  throw clientError("invalid_argument", {
    detail:
      "A share is named by the Share a share call returned, or its URL, such as " +
      `"https://developmentfinance.org/s/k3Qx8vTa", not ${quoted(target)}; ` +
      "client.share(cards, { latest: true }) makes one.",
  });
}

/** The frame one slot of a share shows, and the card that shows it. */
export type ShownFrame = {
  readonly shareId: string;
  /** The slot, from 1. */
  readonly slot: number;
  /** The title the slot's card shows, or null. */
  readonly title: string | null;
  /** The frame's spec id, `spec_<hex>` or `ops_<hex>`. */
  readonly specId: string;
  /** The frame's version, `cv_<hex>` or `ocv_<hex>`. */
  readonly contentVersion: string;
  /** The day the fetch asked about, or the day it read what the slot shows now, at UTC
   *  midnight. */
  readonly on: Date;
};

/** The frame as a dataset's text form names it, as
 *  `share k3Qx8vTa, slot 2 "Malaria grants", on 3 October 2026`. */
export function shownLine({ shareId, slot, title, on }: ShownFrame): string {
  const titled = title ? ` "${clipped(title)}"` : "";
  return `share ${shareId}, slot ${slot}${titled}, on ${dayText(on)}`;
}

/** The text forms `asOf` takes, the same in both clients: a day, or an RFC 3339 date-time with
 *  its offset, `T` and `Z` in either case. */
const AS_OF_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const AS_OF_MOMENT =
  /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(?:([Zz])|([+-])(\d{2}):(\d{2}))$/;
/** From a day's UTC midnight to its last millisecond, where a day read as a moment ends. */
const DAY_END_MS = 86_400_000 - 1;

/** The UTC midnight of a written date, or undefined when the date does not exist. */
function writtenDay(year: number, month: number, date: number): Date | undefined {
  // setUTCFullYear, since Date.UTC reads the years 0 to 99 as 1900 to 1999. Year 0 is refused,
  // as Python's date refuses it.
  const day = new Date(0);
  day.setUTCFullYear(year, month - 1, date);
  return year >= 1 && day.getUTCFullYear() === year && day.getUTCMonth() === month - 1
    ? day
    : undefined;
}

/** The UTC midnight of the day `date` falls on in UTC. */
const utcDay = (date: Date): Date =>
  new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));

/** The UTC midnight of the day a fetch reads what a slot shows now. */
export const today = (): Date => utcDay(new Date());

/** A day, read as its last millisecond in UTC, or an RFC 3339 date-time, to the millisecond,
 *  with the day it writes; undefined for other text or a day or time that does not exist. */
function readWrittenMoment(text: string): { moment: Date; day: Date } | undefined {
  const onlyDay = AS_OF_DAY.exec(text);
  const found = onlyDay ?? AS_OF_MOMENT.exec(text);
  if (found === null) return undefined;
  const [, year, month, date, hour, minute, second, fraction, utc, sign, hours, minutes] = found;
  const day = writtenDay(Number(year), Number(month), Number(date));
  if (day === undefined) return undefined;
  if (onlyDay !== null) return { moment: new Date(day.getTime() + DAY_END_MS), day };
  const [h, m, s, offsetH, offsetM] = [hour, minute, second, hours, minutes].map(Number);
  if (!(h! <= 23 && m! <= 59 && s! <= 59)) return undefined;
  if (utc === undefined && !(offsetH! <= 23 && offsetM! <= 59)) return undefined;
  const offset = utc === undefined ? (sign === "-" ? -1 : 1) * (offsetH! * 60 + offsetM!) : 0;
  const milliseconds = Number((fraction ?? "").padEnd(3, "0").slice(0, 3));
  const moment = day.getTime() + ((h! * 60 + m!) * 60 + s!) * 1000 + milliseconds;
  return { moment: new Date(moment - offset * 60_000), day };
}

/**
 * The moment `asOf` names, and its day at UTC midnight.
 *
 * A day, `YYYY-MM-DD`, reads as the last millisecond of that day in UTC, so it names what the
 * share showed on that day. An RFC 3339 date-time with its offset, such as
 * `2026-10-28T10:00:00Z`, reads as that instant, and its day is the date it writes. A `Date` is
 * the instant it holds, on its UTC day. Any other text is refused, as the Python client refuses
 * it.
 *
 * @throws {InvalidRequestError} `asOf` is none of those (`invalid_argument`).
 */
export function asOfMoment(asOf: unknown): { moment: Date; day: Date } {
  if (asOf instanceof Date && !Number.isNaN(asOf.getTime())) {
    return { moment: asOf, day: utcDay(asOf) };
  }
  if (typeof asOf === "string") {
    const read = readWrittenMoment(asOf);
    if (read !== undefined) return read;
  }
  throw clientError("invalid_argument", {
    detail:
      'asOf is a Date, a date such as "2026-10-28" or an RFC 3339 date-time such as ' +
      '"2026-10-28T10:00:00Z", not ' +
      `${asOf instanceof Date ? "an invalid Date" : quoted(asOf)}.`,
  });
}

/**
 * Refuses a `slot` that is neither undefined, null nor a slot number from 1.
 *
 * @throws {InvalidRequestError} It is not (`invalid_argument`).
 */
export function checkSlot(slot: unknown): asserts slot is number | null | undefined {
  if (slot === undefined || slot === null || (Number.isInteger(slot) && Number(slot) >= 1)) {
    return;
  }
  throw clientError("invalid_argument", {
    detail:
      "slot is numbered from 1, as a share's data URLs are, so slot: 1 is the first card, not " +
      `${quoted(slot)}.`,
  });
}

/**
 * The slot a share fetch reads: `slot`, or the only one of a share of one.
 *
 * @throws {InvalidRequestError} The share has several slots and `slot` is not given, or `slot`
 *   is past its last (`invalid_argument`).
 */
export function chosenSlot(slot: number | undefined, count: number, shareId: string): number {
  if (slot === undefined && count === 1) return 1;
  if (slot !== undefined && slot <= count) return slot;
  let held = `Share ${shareId} has ${count} slot${count === 1 ? "" : "s"}`;
  if (slot !== undefined) held += ` and no slot ${slot}`;
  const picks = count === 1 ? "slot: 1" : `slot: 1 to slot: ${count}`;
  throw clientError("invalid_argument", {
    detail: `${held}; slots are numbered from 1 as its data URLs are, so pick one with ${picks}.`,
  });
}

/**
 * The number of slots a share read lists.
 *
 * @throws {ContractError} The reply has no list of slots (`contract_violation`).
 */
export function readSlotCount(reply: unknown, route: string): number {
  const slots = object(reply, route, "")["slots"];
  if (!Array.isArray(slots)) throw violation(route, "/slots");
  return slots.length;
}

/**
 * The frame a slot's card read is drawn on, or null for a card that draws no frame, such as a
 * note; and the card's title.
 *
 * @throws {ContractError} The reply names no list of inputs, or several, or an input lacks its
 *   spec id or version (`contract_violation`).
 */
export function readShownCard(
  reply: unknown,
  route: string,
): { frame: { specId: string; contentVersion: string } | null; title: string | null } {
  const body = object(reply, route, "");
  const payload = object(body["resolved_payload"], route, "/resolved_payload");
  const pointer = "/resolved_payload/provenance";
  const inputs = object(payload["provenance"], route, pointer)["inputs"];
  if (!Array.isArray(inputs) || inputs.length > 1) {
    throw violation(route, `${pointer}/inputs`, "is not one frame");
  }
  const [entry] = inputs as unknown[];
  if (entry === undefined) return { frame: null, title: cardTitle(body) };
  const at = `${pointer}/inputs/0`;
  const frame = object(entry, route, at);
  return {
    frame: {
      specId: textAt(frame, "spec_id", route, at),
      contentVersion: textAt(frame, "content_version", route, at),
    },
    title: cardTitle(body),
  };
}

/**
 * The write token a change of `target` sends: `writeToken` when given, else the token a `Share`
 * carries, else null.
 *
 * @throws {InvalidRequestError} `writeToken` is neither undefined nor non-empty text
 *   (`invalid_argument`).
 */
export function writeTokenOf(target: unknown, writeToken: unknown): string | null {
  if (writeToken === undefined) return target instanceof Share ? target.writeToken : null;
  if (typeof writeToken !== "string" || writeToken === "") {
    throw clientError("invalid_argument", {
      detail: "writeToken is the shw_ token a share call returned, as non-empty text.",
    });
  }
  return writeToken;
}

function object(value: unknown, route: string, pointer: string): Record<string, unknown> {
  if (!isRecord(value)) throw violation(route, pointer || "the body", "is not an object");
  return value;
}

function textAt(obj: Record<string, unknown>, key: string, route: string, pointer = ""): string {
  const value = obj[key];
  if (typeof value !== "string" || value === "") {
    throw violation(route, `${pointer}/${key}`, "is not text");
  }
  return value;
}

function countAt(obj: Record<string, unknown>, key: string, route: string, pointer = ""): number {
  const value = obj[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw violation(route, `${pointer}/${key}`, "is not a count from 1");
  }
  return value;
}

function flagAt(obj: Record<string, unknown>, key: string, route: string, pointer = ""): boolean {
  const value = obj[key];
  if (typeof value !== "boolean") {
    throw violation(route, `${pointer}/${key}`, "is not true or false");
  }
  return value;
}

const violation = (route: string, pointer: string, fault = "is missing"): ContractError =>
  clientError("contract_violation", {
    detail: `${route} answered a body whose ${pointer} ${fault}.`,
    ...(pointer.startsWith("/") ? { pointer } : {}),
  });
