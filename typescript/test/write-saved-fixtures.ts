/**
 * Writes the saved file the cross-language tests read: a dataset of two members.
 *
 * Run from `typescript/` with `node test/write-saved-fixtures.ts`. It replays the contract
 * scenario `answer-several-readings-folded`, whose answer builds two members that stack into one
 * table, writes the dataset's `toBytes()` to `test/data/saved-typescript.parquet`, and its
 * provenance record beside it as `saved-typescript.provenance.json`. Python's
 * `tests/datasets/test_saved_cross_language.py` reads both. The fetch time is the time of the
 * run, so each run writes new bytes.
 */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";

import { format, resolveConfig } from "prettier";

import { clientOver } from "../src/client.ts";
import { replay, scenario, stepOf } from "./replay.ts";

const SCENARIO = "answer-several-readings-folded";
const parquet = new URL("./data/saved-typescript.parquet", import.meta.url);
const provenance = new URL("./data/saved-typescript.provenance.json", import.meta.url);

const record = await scenario(SCENARIO);
const client = clientOver(replay(record).transport);
const answer = await client.search(stepOf(record, 0, "search").question);
const data = await answer.fetch();
assert.ok(data.members.length > 1, "the scenario no longer stacks several members");
await writeFile(parquet, await data.toBytes());
// Formatted as `pnpm lint` checks it.
await writeFile(
  provenance,
  await format(JSON.stringify(data.provenance), {
    ...(await resolveConfig(provenance)),
    parser: "json",
  }),
);
console.log(`wrote ${parquet.pathname} and ${provenance.pathname}`);
