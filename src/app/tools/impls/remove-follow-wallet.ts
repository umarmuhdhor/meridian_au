import { z } from "zod";
import { defineTool } from "../define-tool.js";

export const removeFollowWalletTool = defineTool({
  name: "remove_follow_wallet",
  description:
    "Stop following a wallet. Any positions still mirrored from it are CLOSED on the next follow tick — a mirror's exit belongs to the wallet it was copied from, so unfollowing unwinds it rather than leaving it with no exit rule at all.",
  args: z.object({ address: z.string().min(32) }),
  result: z.object({
    removed: z.boolean(),
    /** Open mirrors from this wallet — all of them will be closed on the next tick. */
    mirrors_to_close: z.number().int().nonnegative(),
  }),
  execute: async ({ address }, ctx) => {
    const held = (await ctx.repos.follow.listOpenMirrored()).filter(
      (m) => m.source_wallet === address,
    ).length;
    const removed = await ctx.repos.follow.removeWallet(address);
    // The closes are left to the follow cycle rather than run here: it already owns the
    // close mechanics, the notifications and the retry-on-failure behaviour, and routing
    // every unfollow through one path means a hand-edited config drains identically.
    if (removed && held > 0) {
      ctx.logger.warn(
        "follow",
        `${held} mirrored position(s) from ${address.slice(0, 8)}… will be closed on the next follow tick`,
      );
    }
    return { removed, mirrors_to_close: removed ? held : 0 };
  },
});
