// Checked by `pnpm typecheck` and never run. A page types a share slot's JSON data response, and
// the frame its rows come from, with the names `@developmentfinance/client/wire` exports.
import type { ShareFrameModel, ShareSlotDataResponse } from "../src/wire.ts";

export function slotParts(response: ShareSlotDataResponse): [number, ShareFrameModel, object[]] {
  return [response.slot, response.frame, response.rows];
}
