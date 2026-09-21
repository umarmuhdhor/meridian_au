import { z } from "zod";
import { defineTool } from "../define-tool.js";

export const setFollowWalletEnabledTool = defineTool({
  name: "set_follow_wallet_enabled",
  description:
    "Turn mirroring on or off for one followed wallet. Disabling CLOSES any positions still mirrored from it on the next follow tick — they have no local exit rules while mirrored, so leaving them open would leave them with no exit at all. Re-enabling re-seeds the baseline, so positions the wallet opened while it was off are never back-filled.",
  args: z.object({
    address: z.string().min(32),
    enabled: z.boolean(),
  }),
  result: z.object({
    updated: z.boolean(),
    address: z.string(),
    enabled: z.boolean(),
    /** On a disable: open mirrors from this wallet, all closed on the next tick. */
    mirrors_to_close: z.number().int().nonnegative(),
  }),
  execute: async ({ address, enabled }, ctx) => {
    const held = enabled
      ? 0
      : (await ctx.repos.follow.listOpenMirrored()).filter((m) => m.source_wallet === address)
          .length;
    const updated = await ctx.repos.follow.setWalletEnabled(address, enabled);
    if (updated && held > 0) {
      ctx.logger.warn(
        "follow",
        `${held} mirrored position(s) from ${address.slice(0, 8)}… will be closed on the next follow tick`,
      );
    }
    return { updated, address, enabled, mirrors_to_close: updated ? held : 0 };
  },
});
