/**
 * Builds started without waiting for them, as the contract's `mint`, `operation` and `result`
 * steps drive them: a spec's build posted as it stands, or a running build read by its
 * operation id, each with its poller and the dataset once it is done. A fetch waits instead.
 */
import { Dataset } from "../src/datasets/dataset.ts";
import { buildBody, checkedSpec, finish } from "../src/datasets/fetch.ts";
import type { Finishing } from "../src/datasets/fetch.ts";
import { Poller, pollReply, postBuild } from "../src/datasets/operation.ts";
import { renderingFor } from "../src/core/ref.ts";
import type { Layout, Spec } from "../src/core/ref.ts";
import type { Transport } from "../src/http/transport.ts";

/** A build started without waiting for it: its poller, and the dataset once it is done. */
export type StartedBuild = {
  readonly poller: Poller;
  /** Waits for the build, with no deadline, and returns its dataset. */
  readonly result: () => Promise<Dataset>;
};

const NO_DEADLINE = { deadline: Infinity };

/**
 * Posts a spec's build, as it stands, and returns it done or running.
 *
 * @throws {InvalidRequestError} The spec is not one `checkedSpec` accepts.
 * @throws {DfoError} The server refused the build.
 */
export async function mint(
  transport: Transport,
  spec: Spec,
  layout: Layout = "long",
): Promise<StartedBuild> {
  checkedSpec(spec);
  const rendering = renderingFor(layout);
  const finishing = {
    parts: [],
    posted: { spec, entityGroups: spec.resolved?.entity_groups },
    sentence: spec.resolved?.rendered_sentence,
    rendering,
    strict: false,
  };
  const body = buildBody(spec, rendering);
  const poller = new Poller(transport, await postBuild(transport, body, NO_DEADLINE), { body });
  return started(transport, poller, finishing, layout);
}

/**
 * Reads a running build by its operation id. The build's rendering is in its id, so `layout`
 * must be the one it was started with.
 *
 * @throws {NotFoundError} The server holds no operation with that id.
 */
export async function resume(
  transport: Transport,
  operationId: string,
  layout: Layout = "long",
): Promise<StartedBuild> {
  const rendering = renderingFor(layout);
  const finishing = { parts: [], posted: undefined, sentence: undefined, rendering, strict: false };
  const response = await transport.request({
    path: `/datasets/operations/${encodeURIComponent(operationId)}`,
    deadline: Infinity,
  });
  const poller = new Poller(transport, pollReply(response, operationId), {});
  return started(transport, poller, finishing, layout);
}

function started(
  transport: Transport,
  poller: Poller,
  finishing: Finishing,
  layout: Layout,
): StartedBuild {
  return {
    poller,
    result: async () =>
      await Dataset.create(
        [await finish(transport, await poller.wait(NO_DEADLINE), finishing, NO_DEADLINE)],
        { layout },
      ),
  };
}
