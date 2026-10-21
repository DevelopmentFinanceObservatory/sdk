// Brings contract/ to the spec-kit commit contract/SOURCE names, by running the repository's one
// fetcher, scripts/sync_contract.py, through uv on Python 3.12 or later. The fetcher does nothing
// when contract/.synced already names SOURCE. The package scripts that read contract/ run this
// first, and it exits non-zero with the command to run when uv is missing or the fetch fails.
//
//   node scripts/fetch-contract.ts
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const PYTHON = ">=3.12";
const FETCHER = "scripts/sync_contract.py";
const ARGS = ["run", "--no-project", "--python", PYTHON, FETCHER];
const COMMAND = `uv run --no-project --python '${PYTHON}' ${FETCHER}`;

const result = spawnSync("uv", ARGS, { cwd: ROOT, stdio: "inherit" });

if (result.error !== undefined) {
  const missing = "code" in result.error && result.error.code === "ENOENT";
  console.error(
    missing
      ? "fetching contract/ needs uv, which is not on PATH; install it " +
          "(https://docs.astral.sh/uv/) and rerun"
      : `could not run uv to fetch contract/: ${result.error.message}`,
  );
  process.exit(1);
}
if (result.status !== 0) {
  console.error(`fetching contract/ failed; run \`${COMMAND}\` from the repository root to retry`);
  process.exit(result.status ?? 1);
}
