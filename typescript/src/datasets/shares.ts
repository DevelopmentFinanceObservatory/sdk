/**
 * Shares: cards published under one link that follows new data or stays fixed.
 *
 * `share` posts `{cards: [{component_id, revision}], latest, write_token}` to
 * `POST /presentation/shares`, which answers 201 with the share's page, embed and per-slot data
 * URLs and its `shw_` write token. The client mints that token, so a retry of the same create
 * answers the first share instead of making a second one whose token nobody holds, and the
 * create retries as every request does. Each new share counts against a daily allowance per
 * caller, refused 429 `allowance_exhausted` once spent.
 *
 * The routes that change a share send its token in `x-dfo-write-token`, and DFO checks it before
 * anything else: none refuses 403 `write_token_required`, another share's 403
 * `write_token_invalid`.
 *
 * - `share(cards, { latest: true, replace })` sends `PUT /presentation/shares/{id}` `{cards}`:
 *   slot n shows the nth card, and slots past the last card stay empty, so every slot keeps its
 *   URLs. A snapshot refuses 409 `share_not_replaceable`.
 * - `snapshot(share)` sends `POST /presentation/shares/{id}/snapshot`, which fixes a live share
 *   as a snapshot in place, each slot keeping the frame it serves now. A snapshot answers as it
 *   is. No route turns a snapshot live.
 * - `unshare(share)` sends `DELETE /presentation/shares/{id}`, which answers 204, and answers 204
 *   again to a token holder who deletes it once more.
 * - `history(share)` reads the public `GET /presentation/shares/{id}/history`: every frame the
 *   share's slots served, newest first, and each moment a replace left a slot without a card.
 *
 * `shownFrame(share, { slot, asOf })` finds the frame one slot shows, for `client.fetch(share)`.
 * It reads the share's slot count and whether it is live from the public
 * `GET /presentation/shares/{id}`, for a `Share` as for a URL, since a replace or a snapshot since
 * the `Share` was returned changes both. Without `asOf` it reads the slot's card from
 * `GET /presentation/shares/{id}/slots/{n}`, drawn on the frame the slot serves now, which its
 * `resolved_payload.provenance.inputs` name. With `asOf` it reads the history, takes the newest
 * frame the slot first served on or before that moment, the one the history lists first of
 * entries served in one millisecond, and reads that card revision's title
 * from `GET /presentation/components/{id}?revision=n`. When that entry is an empty slot it throws
 * `not_found` without requesting a frame.
 *
 * A share id that names no share, or one taken down, refuses 404 `not_found`.
 */

import { mintToken } from "./cards.ts";
import {
  asOfMoment,
  Card,
  cardTitle,
  checkSlot,
  chosenSlot,
  readHistory,
  readShare,
  readShownCard,
  readSlotCount,
  Share,
  shareIdOf,
  today,
  writeTokenOf,
} from "./publication.ts";
import type { Served, ShareUrl, ShownFrame } from "./publication.ts";
import type { Wait } from "./operation.ts";
import {
  clientError,
  InvalidRequestError,
  NotFoundError,
  optionsOf,
  serverCode,
} from "../core/errors.ts";
import { checkOptions, declareOptions } from "../core/options.ts";
import { quoted } from "../core/text.ts";
import { describing } from "../core/trace.ts";
import type { JsonResponse, Transport } from "../http/transport.ts";

const SHARES_PATH = "/presentation/shares";
const WRITE_TOKEN_HEADER = "x-dfo-write-token";

export type ShareOptions = {
  /** True for a share that follows new data and takes new cards, false for a snapshot that
   *  keeps today's versions. */
  latest: boolean;
  /** The live share whose cards these replace under its URLs: the `Share` a share call
   *  returned, or the URL of its page or embed. */
  replace?: Share | ShareUrl;
  /** The `shw_` token of the share `replace` names, when it is a URL or a `Share` made without
   *  its token. */
  writeToken?: string;
};

export type WriteTokenOptions = {
  /** The share's `shw_` token, when the share is a URL or a `Share` made without its token. */
  writeToken?: string;
};

const SHARE = declareOptions<ShareOptions>("client.share", {
  latest: true,
  replace: true,
  writeToken: true,
});
const SNAPSHOT = declareOptions<WriteTokenOptions>("client.snapshot", { writeToken: true });
const UNSHARE = declareOptions<WriteTokenOptions>("client.unshare", { writeToken: true });

/**
 * Publishes `cards` as a new share, or gives the live share `replace` names these cards under
 * its URLs.
 *
 * @throws {InvalidRequestError} `cards` is not a Card or a non-empty list of them, `latest` is
 *   not a boolean, `replace` is given with `latest: false`, or `replace` or `writeToken` is
 *   malformed (`invalid_argument`), and no request is sent; or DFO refused the token
 *   (`write_token_required`) or the share (`share_not_replaceable`).
 * @throws {PermissionDeniedError} The token is not the share's (`write_token_invalid`).
 * @throws {QuotaExceededError} The daily share allowance is spent (`allowance_exhausted`).
 */
export async function share(
  transport: Transport,
  cards: unknown,
  options: ShareOptions,
): Promise<Share> {
  const shown = shownCards(cards);
  const { latest, replace, writeToken } = checkOptions(SHARE, options);
  if (typeof latest !== "boolean") {
    throw clientError("invalid_argument", {
      detail:
        "latest is true for a share that follows new data or false for a snapshot that keeps " +
        `today's versions, not ${quoted(latest)}.`,
    });
  }
  if (replace === undefined) {
    if (writeToken !== undefined) {
      throw clientError("invalid_argument", {
        detail: "writeToken goes with replace, the share whose cards it replaces.",
      });
    }
    const token = mintToken("shw_");
    const response = await transport.request({
      path: SHARES_PATH,
      json: { cards: shown, latest, write_token: token },
    });
    return shareOf(response, `POST ${SHARES_PATH}`, token);
  }
  const id = shareIdOf(replace);
  if (!latest) {
    throw clientError("invalid_argument", {
      detail:
        "replace gives a live share new cards, so it takes latest: true; " +
        "client.snapshot(share) fixes a live share as it shows now.",
    });
  }
  const token = writeTokenOf(replace, writeToken);
  const path = `${SHARES_PATH}/${id}`;
  const response = await withToken(id, () =>
    transport.request({ method: "PUT", path, json: { cards: shown }, ...tokenHeader(token) }),
  );
  return shareOf(response, `PUT ${path}`, token);
}

/**
 * Fixes the live share `target` names as a snapshot, under the same URLs.
 *
 * @throws {InvalidRequestError} `target` or `writeToken` is malformed (`invalid_argument`), and
 *   no request is sent; or no token was given (`write_token_required`).
 * @throws {PermissionDeniedError} The token is not the share's (`write_token_invalid`).
 */
export async function snapshot(
  transport: Transport,
  target: unknown,
  options?: WriteTokenOptions,
): Promise<Share> {
  const { writeToken } = checkOptions(SNAPSHOT, options);
  const id = shareIdOf(target);
  const token = writeTokenOf(target, writeToken);
  const path = `${SHARES_PATH}/${id}/snapshot`;
  const response = await withToken(id, () =>
    transport.request({ method: "POST", path, ...tokenHeader(token) }),
  );
  return shareOf(response, `POST ${path}`, token);
}

/**
 * Takes the share `target` names down. A token holder who takes it down again succeeds, so a
 * retry is safe.
 *
 * @throws {InvalidRequestError} `target` or `writeToken` is malformed (`invalid_argument`), and
 *   no request is sent; or no token was given (`write_token_required`).
 * @throws {PermissionDeniedError} The token is not the share's (`write_token_invalid`).
 * @throws {NotFoundError} No share has that id (`not_found`).
 */
export async function unshare(
  transport: Transport,
  target: unknown,
  options?: WriteTokenOptions,
): Promise<void> {
  const { writeToken } = checkOptions(UNSHARE, options);
  const id = shareIdOf(target);
  const token = writeTokenOf(target, writeToken);
  // DELETE answers 204 with no body, so its bytes are read as they are.
  await withToken(id, () =>
    transport.requestRaw({ method: "DELETE", path: `${SHARES_PATH}/${id}`, ...tokenHeader(token) }),
  );
}

/**
 * Every frame the share `target` names served, newest first.
 *
 * @throws {InvalidRequestError} `target` is malformed (`invalid_argument`), and no request is
 *   sent.
 * @throws {NotFoundError} No share has that id, or it was taken down (`not_found`).
 */
export async function history(
  transport: Transport,
  target: unknown,
  wait?: Wait,
): Promise<readonly Served[]> {
  const path = `${SHARES_PATH}/${shareIdOf(target)}/history`;
  const response = await transport.request({ path, ...within(wait) });
  return describing(response.traceId, () => readHistory(response.body, `GET ${path}`));
}

/**
 * The frame slot `slot` of the share `target` names shows now, or showed at `asOf`.
 *
 * @throws {InvalidRequestError} `target`, `slot` or `asOf` is malformed, or `slot` is 0
 *   (`invalid_argument`), and no request is sent; `slot` is not given for a share of several
 *   slots, or is past its last; `asOf` is before the slot first served data; or the slot shows a
 *   card that draws no data, such as a note.
 * @throws {NotFoundError} No share has that id, or the slot is empty, or with `asOf` it showed no
 *   card at that moment (`not_found`).
 */
export async function shownFrame(
  transport: Transport,
  target: unknown,
  { slot, asOf }: { slot?: unknown; asOf?: unknown },
  wait: Wait,
): Promise<ShownFrame> {
  const shareId = shareIdOf(target);
  checkSlot(slot);
  const asked = asOf === undefined || asOf === null ? undefined : asOfMoment(asOf);
  const read = `${SHARES_PATH}/${shareId}`;
  const shared = await transport.request({ path: read, ...within(wait) });
  const { count, live } = describing(shared.traceId, () =>
    readSlotCount(shared.body, `GET ${read}`),
  );
  const number = chosenSlot(slot ?? undefined, count, shareId);
  if (asked === undefined) {
    const path = `${SHARES_PATH}/${shareId}/slots/${number}`;
    const response = await transport.request({ path, ...within(wait) });
    const { frame, title } = describing(response.traceId, () =>
      readShownCard(response.body, `GET ${path}`),
    );
    if (frame === null) {
      throw clientError("invalid_argument", {
        detail:
          `Slot ${number} of share ${shareId} shows a card that draws no data, such as a note, ` +
          "so it has no rows to fetch.",
      });
    }
    return { shareId, slot: number, title, ...frame, on: today(), newerNow: false };
  }
  const { moment, day } = asked;
  const served = await history(transport, target, wait);
  // The latest entry at or before the moment wins. Of entries served in one millisecond the
  // first the history lists wins, since DFO lists a slot's entries of one moment newest first.
  const entry = served
    .filter((frame) => frame.slot === number && frame.firstServed.getTime() <= moment.getTime())
    .reduce<Served | undefined>(
      (latest, frame) =>
        latest === undefined || frame.firstServed.getTime() > latest.firstServed.getTime()
          ? frame
          : latest,
      undefined,
    );
  if (entry === undefined) {
    throw clientError("invalid_argument", {
      detail:
        `Slot ${number} of share ${shareId} served no data on or before ` +
        `${day.toISOString().slice(0, 10)}; client.history(share) lists what each slot showed ` +
        "and when.",
    });
  }
  if (
    entry.cardId === null ||
    entry.cardRevision === null ||
    entry.specId === null ||
    entry.contentVersion === null
  ) {
    throw new NotFoundError({
      code: serverCode("not_found"),
      detail:
        `Slot ${number} of share ${shareId} showed no card on ${day.toISOString().slice(0, 10)}; ` +
        "client.history(share) lists what each slot showed and when.",
    });
  }
  const path = `/presentation/components/${entry.cardId}?revision=${entry.cardRevision}`;
  const response = await transport.request({ path, ...within(wait) });
  return {
    shareId,
    slot: number,
    title: cardTitle(response.body),
    specId: entry.specId,
    contentVersion: entry.contentVersion,
    on: day,
    newerNow: live,
  };
}

/** A read's deadline and signal from a fetch's wait, or none outside a fetch. */
const within = (wait: Wait | undefined): { deadline?: number; signal?: AbortSignal | undefined } =>
  wait === undefined ? {} : { deadline: wait.deadline, signal: wait.signal };

/** The cards a share shows, slot 1 first, as the request names them. */
function shownCards(cards: unknown): { component_id: string; revision: number }[] {
  const list = cards instanceof Card ? [cards] : cards;
  if (
    !Array.isArray(list) ||
    list.length === 0 ||
    !list.every((card): card is Card => card instanceof Card)
  ) {
    throw clientError("invalid_argument", {
      detail:
        "A share shows a Card or a list of Cards, such as await client.cards.line(data), not " +
        `${Array.isArray(list) ? "that list" : quoted(list)}.`,
    });
  }
  return list.map((card) => ({ component_id: card.id, revision: card.revision }));
}

/**
 * Sends a change of share `shareId` with its write token.
 *
 * @throws {InvalidRequestError} No token was given (`write_token_required`); the message names
 *   the option that takes it.
 */
async function withToken<T>(shareId: string, send: () => Promise<T>): Promise<T> {
  try {
    return await send();
  } catch (error) {
    if (!(error instanceof InvalidRequestError) || error.code !== "write_token_required") {
      throw error;
    }
    throw new InvalidRequestError({
      ...optionsOf(error),
      message:
        `Changing share ${shareId} needs its write token: pass { writeToken: "shw_…" }, the ` +
        "token on the Share client.share returned, which DFO gives only when the share is made.",
    });
  }
}

const tokenHeader = (token: string | null): { headers?: Record<string, string> } =>
  token === null ? {} : { headers: { [WRITE_TOKEN_HEADER]: token } };

function shareOf(response: JsonResponse, route: string, token: string | null): Share {
  return describing(response.traceId, () => readShare(response.body, route, token));
}
