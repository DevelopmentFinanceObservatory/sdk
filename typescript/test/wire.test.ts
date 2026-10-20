// Type-level checks on the generated wire types; `pnpm typecheck` fails when one breaks.
import assert from "node:assert/strict";
import { test } from "node:test";

import { isKnownPart, PART_STATUSES } from "../src/parts.ts";
import type {
  DefinitePart,
  OperationEnvelope,
  Part,
  RequestedOperation,
  Resolution,
  UnknownPart,
} from "../src/wire.ts";

/** Compiles only when the two types are the same. */
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- a type-level proof
function sameType<A, B extends A>(...proof: A extends B ? [] : [never]): void {
  assert.equal(proof.length, 0);
}

function describePart(part: Part): string {
  if (!isKnownPart(part)) {
    sameType<typeof part, UnknownPart>();
    return part.status;
  }
  switch (part.status) {
    case "definite":
      sameType<typeof part, DefinitePart>();
      return part.spec.spec_id;
    case "candidates":
      return `${String(part.candidates.specs.length)} readings`;
    case "no_data":
      return part.no_data.reason;
    case "unsupported":
      return part.unsupported.code;
  }
}

test("Resolution parts hold UnknownPart, and isKnownPart separates it from the known parts", () => {
  const parts: Resolution["parts"] = [
    { status: "status_from_a_newer_server" },
    { status: "unsupported", unsupported: { code: "capability_unavailable" } },
  ];
  assert.deepEqual(parts.map(describePart), [
    "status_from_a_newer_server",
    "capability_unavailable",
  ]);
  assert.deepEqual(PART_STATUSES, ["definite", "candidates", "no_data", "unsupported"]);
});

test("string enums accept values the server adds; Operation is RequestedOperation", () => {
  const status: OperationEnvelope["status"] = "status_from_a_newer_server";
  const verb: RequestedOperation["verb"] = "verb_from_a_newer_server";
  assert.ok(status && verb);
});
