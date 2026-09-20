import { z } from "zod";
import { defineTool } from "../define-tool.js";

export const setFollowWalletEnabledTool = defineTool({
  name: "set_follow_wallet_enabled",
  description:
    "Turn mirroring on or off for one followed wallet. Re-enabling re-seeds the baseline, so positions the wallet opened while it was off are never back-filled.",
  args: z.object({
    address: z.string().min(32),
    enabled: z.boolean(),
  }),
  result: z.object({
    updated: z.boolean(),
    address: z.string(),
    enabled: z.boolean(),
  }),
  execute: async ({ address, enabled }, ctx) => {
    const updated = await ctx.repos.follow.setWalletEnabled(address, enabled);
    return { updated, address, enabled };
  },
});
