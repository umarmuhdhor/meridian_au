import { z } from "zod";
import { defineTool } from "../define-tool.js";

export const listFollowWalletsTool = defineTool({
  name: "list_follow_wallets",
  description:
    "List followed wallets, their on/off state, and how many positions are currently mirrored from each.",
  args: z.object({}),
  result: z.object({
    global_follow_enabled: z.boolean(),
    wallets: z.array(
      z.object({
        address: z.string(),
        label: z.string(),
        enabled: z.boolean(),
        seeded: z.boolean(),
        open_mirrors: z.number().int().nonnegative(),
        size_pct_override: z.number().nullable(),
        added_at: z.string(),
      }),
    ),
  }),
  execute: async (_args, ctx) => {
    const wallets = await ctx.repos.follow.listWallets();
    const open = await ctx.repos.follow.listOpenMirrored();
    const rows = await Promise.all(
      wallets.map(async (w) => ({
        address: w.address,
        label: w.label,
        enabled: w.enabled,
        seeded: (await ctx.repos.follow.getSeen(w.address)) != null,
        open_mirrors: open.filter((m) => m.source_wallet === w.address).length,
        size_pct_override: w.sizePctOverride,
        added_at: w.addedAt,
      })),
    );
    return { global_follow_enabled: ctx.config.follow.enabled, wallets: rows };
  },
});
