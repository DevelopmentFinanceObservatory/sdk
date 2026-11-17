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
 *
 * `fileUrl` gives a pinned member's file as a link a pipeline can commit and read with any HTTP
 * client: the file selector, `GET /datasets/{spec_id}/{content_version}/file`, under the client's
 * base URL, with the query of the rendering the member was built in, so it serves the same table.
 * It reads the version's manifest first and refuses a version that is not pinned, since DFO holds
 * an unpinned version for 30 days and a committed link to it breaks after that.
 */

import { Dataset, dayText, pinnedDataset } from "./dataset.ts";
import type { DerivedMember, Member } from "./dataset.ts";
import { invalid } from "./fetch.ts";
import { storedManifest } from "./resolve.ts";
import { clientError, DfoError, messageOf, optionsOf } from "../core/errors.ts";
import type { DfoErrorOptions } from "../core/errors.ts";
import { isRecord } from "../core/json.ts";
import { trimEnd, WHITESPACE } from "../core/text.ts";
import { isDerived, selectorPath } from "../core/ref.ts";
import type { DerivedRefMember, RefMember } from "../core/ref.ts";
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
  const deadline = transport.callDeadline();
  for (const [index, member] of members.entries()) {
    try {
      await pinMember(transport, member, deadline);
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
        "a frame DFO computed, which the pin route does not take. data.toBytes() keeps its rows, " +
        "and client.fetch(data.ref, { latest: true }) computes it again.",
    );
  }
  return data.members.filter((member): member is Member => !isDerived(member));
}

const typeName = (value: unknown): string =>
  value === null ? "null" : Array.isArray(value) ? "an array" : typeof value;

/** Pins one member's artifact, once DFO's answer names its version and digest. */
async function pinMember(transport: Transport, member: Member, deadline: number): Promise<void> {
  const path = `/datasets/${member.spec.spec_id}/${member.contentVersion}/pin`;
  const response = await transport.request({
    path,
    json: { schema_version: 1, artifact_digest: member.digest },
    deadline,
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

/**
 * The URL of a pinned member's file, in the rendering it was built in.
 *
 * @throws {VersionNotPinnedError} The version is not pinned (`version_not_pinned`), with
 *   `heldUntil` naming when DFO stops guaranteeing it.
 * @throws {InvalidRequestError} `member` is not a member of a dataset or its ref, or names a
 *   frame DFO computed (`invalid_argument`), and no request is sent.
 * @throws {DfoError} Whatever reading the version's manifest threw, such as `NotFoundError` for a
 *   version DFO never stored.
 */
export async function fileUrl(
  transport: Transport,
  member: Member | RefMember | DerivedMember | DerivedRefMember,
): Promise<string> {
  const reading = readingOf(member);
  const { spec_id: specId } = reading.spec;
  const { manifest, traceId } = await storedManifest(transport, specId, reading.contentVersion, {
    deadline: transport.callDeadline(),
  });
  const retention = isRecord(manifest["retention"]) ? manifest["retention"] : {};
  if (retention["pinned"] !== true) {
    const heldUntil = heldUntilOf(retention["held_until"]);
    const held = heldUntil === null ? "" : `, held until ${dayText(heldUntil)}`;
    throw clientError("version_not_pinned", {
      detail:
        `${specId} at ${reading.contentVersion} is not pinned${held}, so a link to it stops ` +
        "working once DFO drops the version. Pin the dataset the member came from with " +
        "client.pin(data), then ask for the link again.",
      traceId,
      heldUntil,
    });
  }
  return transport.url({ path: selectorPath(reading) }).href;
}

/** `member`, refused unless it is a dataset version's member. */
function readingOf(member: unknown): Member | RefMember {
  if (!isRecord(member) || !isRecord(member["spec"]) || !("contentVersion" in member)) {
    throw invalid(
      "fileUrl takes a member of a dataset, such as data.members[0] or data.ref.members[0] " +
        `after const data = await client.fetch(spec), not ${member instanceof Dataset ? "a Dataset" : typeName(member)}.`,
    );
  }
  const reading = member as Member | RefMember | DerivedRefMember;
  if (isDerived(reading)) {
    throw invalid(
      `fileUrl links to dataset versions, and ${reading.spec.spec_id} at ` +
        `${reading.contentVersion} is a frame DFO computed, which has no stored file to link to. ` +
        "data.toBytes() keeps its rows.",
    );
  }
  return reading;
}

/** A retention's `held_until` as a date, or null when it is not one. */
function heldUntilOf(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
