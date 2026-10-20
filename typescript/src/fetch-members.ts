/**
 * The interface `Answer.fetch` builds through. The fetch module replaces this file with the
 * implementation; these names and shapes are what an answer calls.
 */
import type { Gap } from "./answer.ts";
import type { Transport } from "./transport.ts";
import type { SpecDefinition } from "./wire.ts";

export type Layout = "long" | "frame";

/** One reading to build: the answer parts it answers, its spec and Search's sentence for it. */
export type FetchMember = {
  /** The variable text of each part the spec answers, in query order. */
  readonly parts: readonly string[];
  readonly spec: { readonly spec_id: string; readonly definition: SpecDefinition };
  readonly sentence: string;
};

/** How far a build has got. */
export type FetchProgress = { readonly rowsWritten?: number; readonly estimateRows?: number };

export type FetchMembersOptions = {
  readonly layout: Layout;
  readonly strict: boolean;
  /** The deadline for the whole build, in milliseconds. */
  readonly timeout: number;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: FetchProgress) => void;
  /** The answer's gaps a partial fetch leaves out, which the dataset lists as missing. */
  readonly missing: readonly Gap[];
};

/** The dataset a fetch returns. */
export type Dataset = { readonly complete: boolean; readonly missing: readonly Gap[] };

export type FetchMembers = (
  transport: Transport,
  members: readonly FetchMember[],
  options: FetchMembersOptions,
) => Promise<Dataset>;

/** Builds each member once, in order, and stacks them into one dataset. */
export const fetchMembers: FetchMembers = () =>
  Promise.reject(new Error("fetchMembers is provided by the fetch module"));
