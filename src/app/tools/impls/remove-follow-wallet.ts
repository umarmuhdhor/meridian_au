import { z } from "zod";
import { defineTool } from "../define-tool.js";

export const removeFollowWalletTool = defineTool({
  name: "remove_follow_wallet",
  description:
    "Stop following a wallet. Positions already mirrored from it stay OPEN and are no longer tracked for the source's exit — close them manually or via the normal exit rules.",
  args: z.object({ address: z.string().min(32) }),
  result: z.object({
    removed: z.boolean(),
    orphaned_open_mirrors: z.number().int().nonnegative(),
  }),
  execute: async ({ address }, ctx) => {
    const orphaned = (await ctx.repos.follow.listOpenMirrored()).filter(
      (m) => m.source_wallet === address,
    ).length;
    const removed = await ctx.repos.follow.removeWallet(address);
    return { removed, orphaned_open_mirrors: removed ? orphaned : 0 };
  },
});
