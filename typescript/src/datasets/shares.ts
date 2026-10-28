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
 * - `unshare(share)` sends `DELETE /presentation/shares/{id}`, which answers 204.
 * - `history(share)` reads the public `GET /presentation/shares/{id}/history`: every frame the
 *   share's slots served, newest first.
 *
 * A share id that names no share, or one taken down, refuses 404 `not_found`.
 */

import { mintToken } from "./cards.ts";
import { Card, readHistory, readShare, shareIdOf, writeTokenOf } from "./publication.ts";
import type { Served, Share } from "./publication.ts";
import { clientError } from "../core/errors.ts";
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
  replace?: Share | string;
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
  const response = await transport.request({
    method: "PUT",
    path,
    json: { cards: shown },
    ...tokenHeader(token),
  });
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
  const response = await transport.request({ method: "POST", path, ...tokenHeader(token) });
  return shareOf(response, `POST ${path}`, token);
}

/**
 * Takes the share `target` names down.
 *
 * @throws {InvalidRequestError} `target` or `writeToken` is malformed (`invalid_argument`), and
 *   no request is sent; or no token was given (`write_token_required`).
 * @throws {PermissionDeniedError} The token is not the share's (`write_token_invalid`).
 * @throws {NotFoundError} No share has that id, or it was taken down (`not_found`).
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
  await transport.requestRaw({
    method: "DELETE",
    path: `${SHARES_PATH}/${id}`,
    ...tokenHeader(token),
  });
}

/**
 * Every frame the share `target` names served, newest first.
 *
 * @throws {InvalidRequestError} `target` is malformed (`invalid_argument`), and no request is
 *   sent.
 * @throws {NotFoundError} No share has that id, or it was taken down (`not_found`).
 */
export async function history(transport: Transport, target: unknown): Promise<readonly Served[]> {
  const path = `${SHARES_PATH}/${shareIdOf(target)}/history`;
  const response = await transport.request({ path });
  return describing(response.traceId, () => readHistory(response.body, `GET ${path}`));
}

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

const tokenHeader = (token: string | null): { headers?: Record<string, string> } =>
  token === null ? {} : { headers: { [WRITE_TOKEN_HEADER]: token } };

function shareOf(response: JsonResponse, route: string, token: string | null): Share {
  return describing(response.traceId, () => readShare(response.body, route, token));
}
