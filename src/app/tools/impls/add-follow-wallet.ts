import { z } from "zod";
import { defineTool } from "../define-tool.js";

export const addFollowWalletTool = defineTool({
  name: "add_follow_wallet",
  description:
    "Follow a wallet: Meridian mirrors its DLMM entries and exits, bypassing screening and the TA gate. The wallet is added enabled, but nothing is mirrored until follow.enabled is also true. Positions the wallet already holds are never back-filled — only entries made after it is added.",
  args: z.object({
    address: z.string().min(32),
    label: z.string().default(""),
    enabled: z.boolean().default(true),
    size_pct_override: z
      .number()
      .positive()
      .max(1)
      .nullable()
      .default(null)
      .describe("Per-wallet override of follow.positionSizePct (fraction of free SOL)."),
    notes: z.string().nullable().default(null),
  }),
  result: z.object({
    added: z.literal(true),
    address: z.string(),
    global_follow_enabled: z.boolean(),
  }),
  execute: async (args, ctx) => {
    await ctx.repos.follow.addWallet({
      address: args.address,
      label: args.label,
      enabled: args.enabled,
      addedAt: ctx.clock.now().toISOString(),
      sizePctOverride: args.size_pct_override,
      notes: args.notes,
    });
    return {
      added: true as const,
      address: args.address,
      global_follow_enabled: ctx.config.follow.enabled,
    };
  },
});
