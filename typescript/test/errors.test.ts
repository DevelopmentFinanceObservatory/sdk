import assert from "node:assert/strict";
import { test } from "node:test";

import {
  actionFor,
  AuthenticationError,
  clientError,
  ContractError,
  DfoError,
  DfoTimeoutError,
  errorClassFor,
  IncompleteAnswerError,
  InvalidRequestError,
  isDfoError,
  NotFoundError,
  PermissionDeniedError,
  RateLimitError,
  ServerError,
  serverCode,
  VersionUnavailableError,
} from "../src/core/errors.ts";
import type { ClientErrorCode } from "../src/core/errors.ts";
import { CLIENT_WARNING_CODES } from "../src/generated/warning-codes.ts";
import { clientWarning, warnOnce } from "../src/core/warnings.ts";
import type { ClientWarningCode } from "../src/core/warnings.ts";
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
    assert.ok(new ErrorClass({ code: serverCode(code) }) instanceof DfoError, code);
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
  [408, DfoTimeoutError],
  [409, InvalidRequestError],
  [410, NotFoundError],
  [429, RateLimitError],
  [502, ServerError],
] as const) {
  test(`an unknown code with HTTP ${status} maps to ${expected.name}`, () => {
    assert.equal(errorClassFor("code_from_a_newer_server", status), expected);
  });
}

test("every code in contract/client-codes.json builds an error of its class and flag", async () => {
  const { codes } = await contractJson<{
    codes: { code: string; class: string; retryable: boolean | "by_status" }[];
  }>("client-codes.json");
  assert.ok(codes.length > 0);
  for (const { code, class: name, retryable } of codes) {
    if (name === "by_status") continue;
    const error = clientError(code as Exclude<ClientErrorCode, "refusal_without_code">, {});
    assert.ok(error instanceof DfoError, code);
    assert.equal(error.name, name, code);
    assert.equal(error.code, code, code);
    assert.equal(error.retryable, retryable, code);
  }
});

test("the client's warning codes are exactly contract/warning-codes.json's, each of its class", async () => {
  const { codes } = await contractJson<{ codes: { code: string; class: string }[] }>(
    "warning-codes.json",
  );
  assert.deepEqual(
    { ...CLIENT_WARNING_CODES },
    Object.fromEntries(codes.map(({ code, class: name }) => [code, name])),
  );
  for (const { code, class: name } of codes) {
    const warning = clientWarning(code as ClientWarningCode, "message");
    assert.equal(warning.name, name, code);
    assert.equal(warning.code, code, code);
  }
});

test("a refusal with no code takes the class and retryable flag its status maps to", () => {
  for (const [status, expected, retryable] of [
    [400, InvalidRequestError, false],
    [408, DfoTimeoutError, true],
    [410, NotFoundError, false],
    [501, ServerError, false],
    [503, ServerError, true],
  ] as const) {
    const error = clientError("refusal_without_code", { status });
    assert.ok(error instanceof expected, String(status));
    assert.equal(error.code, "refusal_without_code");
    assert.equal(error.status, status);
    assert.equal(error.retryable, retryable, String(status));
  }
});

test("isDfoError holds across copies of the package and rejects look-alikes", () => {
  const error = new NotFoundError({ code: serverCode("snapshot_not_found"), status: 404 });
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

test("an error the client raises takes a code from ClientErrorCode", () => {
  // @ts-expect-error -- a server's code reaches an error only through serverCode.
  const error = new ServerError({ code: "not_a_client_code" });
  assert.equal(error.code, "not_a_client_code");
});

test("warnOnce forgets what it has seen once it holds 1,024 keys", () => {
  const shown: string[] = [];
  const once = (key: string): void => {
    warnOnce(key, clientWarning("ref_digest_changed", key), (warning) => {
      shown.push(warning.message);
    });
  };
  once("cap:first");
  once("cap:first");
  assert.deepEqual(shown, ["cap:first"]);
  for (let index = 0; index < 1024; index += 1) once(`cap:${index}`);
  once("cap:first");
  assert.equal(shown.length, 1026);
  assert.equal(shown.at(-1), "cap:first");
});
