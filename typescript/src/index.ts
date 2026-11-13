/**
 * The `@developmentfinance/client` entry point: the client, what its calls return, and the
 * helpers a recipe starts from. It holds the names Python's `dfo` holds at its top level.
 * `@developmentfinance/client/errors` holds the errors and warnings, and
 * `@developmentfinance/client/types` the types and helpers a caller rarely names.
 */
export { Answer } from "./search/answer.ts";
export { Client } from "./client.ts";
export type { ClientOptions } from "./client.ts";
export { Dataset } from "./datasets/dataset.ts";
export { recipe } from "./datasets/recipe.ts";
export { latestYear } from "./core/periods.ts";
export { DatasetRef } from "./core/ref.ts";
export type { Spec } from "./core/ref.ts";
export { VERSION } from "./version.ts";
