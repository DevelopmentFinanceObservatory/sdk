/**
 * Pinning: keeping a dataset's exact versions fetchable with no time limit.
 *
 * `pin` posts each member's artifact digest to `POST /datasets/{spec_id}/{content_version}/pin`,
 * `{schema_version: 1, artifact_digest}`, one member after another. DFO keeps the artifact and a
 * frame that serves its version in the pinned tier, so every format of the version stays
 * fetchable by its ref. Pinning cannot be undone, and each new pin counts against a daily
 * allowance per caller, which answers 429 `allowance_exhausted` once spent. A call that fails
 * part-way leaves the members before the failing one pinned, and its error names their versions
 * in `pinned` and in its message.
 *
 * The pin route takes dataset versions alone, so a derived dataset, whose members name `ops_`
 * frames, is refused before any request.
 */

import { Dataset, pinnedDataset } from "./dataset.ts";
import type { Member } from "./dataset.ts";
import { invalid } from "./fetch.ts";
import { clientError, DfoError, messageOf, optionsOf } from "../core/errors.ts";
import type { DfoErrorOptions } from "../core/errors.ts";
import { isRecord } from "../core/json.ts";
import { trimEnd, WHITESPACE } from "../core/text.ts";
import { isDerived } from "../core/ref.ts";
import type { Transport } from "../http/transport.ts";

/**
 * Keeps `data`'s versions fetchable with no time limit, and returns it pinned.
 *
 * @throws {InvalidRequestError} `data` is not a Dataset, or holds frames DFO computed
 *   (`invalid_argument`); no request is sent.
 * @throws {QuotaExceededError} The caller's daily pin allowance is spent
 *   (`allowance_exhausted`).
 * @throws {ContractError} DFO answered for another version or artifact (`contract_violation`).
 * @throws {DfoError} Whatever the failing pin threw, with `pinned` naming the versions pinned
 *   before it, which stay pinned.
 */
export async function pin(transport: Transport, data: Dataset): Promise<Dataset> {
  const members = datasetMembers(data);
  for (const [index, member] of members.entries()) {
    try {
      await pinMember(transport, member);
    } catch (error) {
      if (index === 0 || !(error instanceof DfoError)) throw error;
      throw partWay(error, members.slice(0, index));
    }
  }
  return pinnedDataset(data);
}

/** `error`, of its own class, naming the members a pin pinned before it failed. */
function partWay(error: DfoError, pinned: readonly Member[]): DfoError {
  const ErrorClass = error.constructor as new (options: DfoErrorOptions) => DfoError;
  const named = pinned.map((member) => `${member.spec.spec_id} at ${member.contentVersion}`);
  const hint = `Pinned before it failed, and still pinned: ${named.join(", ")}.`;
  const hinted = (text: string) => `${trimEnd(text, `.${WHITESPACE}`)}. ${hint}`;
  return new ErrorClass({
    ...optionsOf(error),
    detail: hinted(error.detail),
    message: hinted(messageOf(error)),
    pinned: pinned.map((member) => member.contentVersion),
  });
}

function datasetMembers(data: unknown): readonly Member[] {
  if (!(data instanceof Dataset)) {
    throw invalid(`pin takes a Dataset, such as await client.fetch(spec), not ${typeName(data)}.`);
  }
  const derived = data.members.find(isDerived);
  if (derived !== undefined) {
    throw invalid(
      `pin keeps dataset versions, and ${derived.spec.spec_id} at ${derived.contentVersion} is ` +
        "a frame DFO computed, which the pin route does not take. data.bytes() keeps its rows, " +
        "and client.fetch(data.ref, { latest: true }) computes it again.",
    );
  }
  return data.members.filter((member): member is Member => !isDerived(member));
}

const typeName = (value: unknown): string =>
  value === null ? "null" : Array.isArray(value) ? "an array" : typeof value;

/** Pins one member's artifact, once DFO's answer names its version and digest. */
async function pinMember(transport: Transport, member: Member): Promise<void> {
  const path = `/datasets/${member.spec.spec_id}/${member.contentVersion}/pin`;
  const response = await transport.request({
    path,
    json: { schema_version: 1, artifact_digest: member.digest },
  });
  const pinned = isRecord(response.body) ? response.body["pinned"] : undefined;
  if (
    !isRecord(pinned) ||
    pinned["content_version"] !== member.contentVersion ||
    pinned["artifact_digest"] !== member.digest
  ) {
    throw clientError("contract_violation", {
      detail: `POST ${path} answered no pin of ${member.contentVersion} at ${member.digest}.`,
      traceId: response.traceId,
    });
  }
}
