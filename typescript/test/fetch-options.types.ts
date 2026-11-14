// Checked by `pnpm typecheck` and never run: each `@ts-expect-error` line passes an option its
// target does not take, so the check fails if the option types ever accept it.
import type { Answer } from "../src/search/answer.ts";
import type { Client } from "../src/client.ts";
import type { DatasetRef, Spec } from "../src/core/ref.ts";
import type { Share } from "../src/datasets/publication.ts";
import type { Recipe } from "../src/datasets/recipe.ts";
import type { Match } from "../src/search/lookup-results.ts";

export async function specOptions(client: Client, spec: Spec, kenya: Match): Promise<void> {
  await client.fetch(spec, {
    window: [2015, 2024],
    entities: { place: ["country/NGA", kenya] },
    facets: { unit: "USDollar" },
    partyTotals: true,
    layout: "long",
    timeout: 60_000,
    strict: true,
  });
  // @ts-expect-error latest is for a ref or a recipe.
  await client.fetch(spec, { latest: true });
  // @ts-expect-error asOf is for a share.
  await client.fetch(spec, { asOf: "2026-10-28" });
  // @ts-expect-error slot is for a share.
  await client.fetch(spec, { slot: 1 });
}

export async function refOptions(client: Client, ref: DatasetRef): Promise<void> {
  await client.fetch(ref, { latest: true, layout: "frame", onProgress: () => undefined });
  // @ts-expect-error A ref takes no window.
  await client.fetch(ref, { window: "latest" });
  // @ts-expect-error A ref takes no entities.
  await client.fetch(ref, { entities: { place: ["country/NGA"] } });
  // @ts-expect-error A ref takes no facets.
  await client.fetch(ref, { facets: { unit: "USDollar" } });
  // @ts-expect-error A ref holds its own party totals.
  await client.fetch(ref, { partyTotals: true });
  // @ts-expect-error slot is for a share.
  await client.fetch(ref, { slot: 1 });
}

export async function recipeOptions(client: Client, recipe: Recipe): Promise<void> {
  await client.fetch(recipe, { latest: true, strict: true, layout: "frame" });
  // @ts-expect-error DFO reports no progress while it computes a recipe.
  await client.fetch(recipe, { onProgress: () => undefined });
  // @ts-expect-error A recipe's frame is in the frame layout.
  await client.fetch(recipe, { layout: "long" });
  // @ts-expect-error A recipe takes no window; its starting readings do.
  await client.fetch(recipe, { window: "all" });
  // @ts-expect-error A recipe takes no party totals; its starting readings do.
  await client.fetch(recipe, { partyTotals: true });
  // @ts-expect-error asOf is for a share.
  await client.fetch(recipe, { asOf: "2026-10-28" });
}

export async function shareOptions(client: Client, share: Share): Promise<void> {
  await client.fetch(share, { slot: 1, asOf: new Date(), onProgress: () => undefined });
  await client.fetch("https://developmentfinance.org/s/k3Qx8vTa", { slot: 2 });
  // @ts-expect-error A share shows its frame as it is.
  await client.fetch(share, { latest: true });
  // @ts-expect-error A share takes no narrowing.
  await client.fetch(share, { entities: { place: ["country/NGA"] } });
  // @ts-expect-error A share takes no party totals.
  await client.fetch(share, { partyTotals: false });
  // @ts-expect-error A share's frame is in the frame layout.
  await client.fetch("https://developmentfinance.org/s/k3Qx8vTa", { layout: "long" });
}

export async function anyTarget(client: Client, target: Spec | DatasetRef | Share): Promise<void> {
  await client.fetch(target, { timeout: 60_000, strict: true });
  // @ts-expect-error A target of unknown kind takes only the options every target shares.
  await client.fetch(target, { latest: true });
}

export async function answerOptions(answer: Answer, kenya: Match): Promise<void> {
  await answer.fetch({ entities: { place: [kenya] }, partial: true, partyTotals: true });
  // @ts-expect-error An answer fetches its readings' newest versions.
  await answer.fetch({ latest: true });
  // @ts-expect-error asOf is for a share.
  await answer.fetch({ asOf: "2026-10-28" });
}
