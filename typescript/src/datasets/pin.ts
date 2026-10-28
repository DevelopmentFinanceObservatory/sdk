/**
 * Pinning: keeping a dataset's exact versions fetchable with no time limit.
 *
 * `pin` posts each member's artifact digest to `POST /datasets/{spec_id}/{content_version}/pin`,
 * `{schema_version: 1, artifact_digest}`, one member after another. DFO keeps the artifact and a
 * frame that serves its version in the pinned tier, so every format of the version stays
 * fetchable by its ref. Pinning cannot be undone, and each new pin counts against a daily
 * allowance per caller, which answers 429 `allowance_exhausted` once spent.
 *
 * The pin route takes dataset versions alone, so a derived dataset, whose members name `ops_`
 * frames, is refused before any request.
 */

import { Dataset, pinnedDataset } from "./dataset.ts";
import type { Member } from "./dataset.ts";
import { invalid } from "./fetch.ts";
import { clientError } from "../core/errors.ts";
import { isRecord } from "../core/json.ts";
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
 */
export async function pin(transport: Transport, data: Dataset): Promise<Dataset> {
  for (const member of datasetMembers(data)) await pinMember(transport, member);
  return pinnedDataset(data);
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
