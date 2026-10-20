import assert from "node:assert/strict";
import { test } from "node:test";

import {
  actionFor,
  AuthenticationError,
  ContractError,
  DfoError,
  errorClassFor,
  IncompleteAnswerError,
  InvalidRequestError,
  isDfoError,
  NotFoundError,
  PermissionDeniedError,
  RateLimitError,
  ServerError,
  VersionUnavailableError,
} from "../src/errors.ts";
import { contractJson } from "./support.ts";

test("every code in contract/actions.json maps to a class below DfoError", async () => {
  const { codes } = await contractJson<{ codes: { code: string; action: string }[] }>(
    "actions.json",
  );
  assert.ok(codes.length > 0);
  for (const { code, action } of codes) {
    assert.equal(actionFor(code), action, code);
    const ErrorClass = errorClassFor(code, 400);
    assert.notEqual(ErrorClass, DfoError, code);
    assert.ok(new ErrorClass({ code }) instanceof DfoError, code);
  }
});

test("a code maps on its action before its HTTP status", () => {
  assert.equal(errorClassFor("snapshot_revoked", 404), VersionUnavailableError);
  assert.equal(errorClassFor("artifact_not_found", 500), NotFoundError);
  assert.equal(errorClassFor("internal_error", 400), ServerError);
  assert.equal(errorClassFor("unsupported_schema_version", 400), ContractError);
  assert.equal(errorClassFor("entity_ambiguous", 422), IncompleteAnswerError);
});

for (const [status, expected] of [
  [400, InvalidRequestError],
  [401, AuthenticationError],
  [403, PermissionDeniedError],
  [404, NotFoundError],
  [409, InvalidRequestError],
  [429, RateLimitError],
  [502, ServerError],
] as const) {
  test(`an unknown code with HTTP ${status} maps to ${expected.name}`, () => {
    assert.equal(errorClassFor("code_from_a_newer_server", status), expected);
  });
}

test("isDfoError holds across copies of the package and rejects look-alikes", () => {
  const error = new NotFoundError({ code: "snapshot_not_found", status: 404 });
  assert.ok(isDfoError(error));
  assert.equal(error.name, "NotFoundError");
  // A second copy of the package brands its errors with the same registered symbol.
  const fromOtherCopy = Object.assign(new Error("x"), { [Symbol.for("dfo.error")]: true });
  assert.ok(isDfoError(fromOtherCopy));
  assert.ok(!isDfoError(Object.assign(new Error("x"), { code: "snapshot_not_found" })));
  assert.ok(!isDfoError(null));
});

test("a transport failure keeps the platform's error as the cause", () => {
  const cause = new TypeError("fetch failed");
  const error = new DfoError({ code: "network_error", cause });
  assert.equal(error.cause, cause);
  assert.equal(error.message, "network_error");
});
