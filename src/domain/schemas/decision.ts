import { z } from "zod";

export const DecisionTypeSchema = z.enum(["deploy", "close", "skip", "no_deploy", "note"]);
export type DecisionType = z.infer<typeof DecisionTypeSchema>;

export const DecisionActorSchema = z.enum(["SCREENER", "MANAGER", "GENERAL", "SAGE", "FOLLOW"]);
export type DecisionActor = z.infer<typeof DecisionActorSchema>;

export const DecisionEntrySchema = z.object({
  id: z.string(),
  ts: z.string(),
  type: DecisionTypeSchema,
  actor: DecisionActorSchema,
  pool: z.string().nullable(),
  pool_name: z.string().nullable(),
  position: z.string().nullable().optional(),
  summary: z.string().nullable(),
  reason: z.string().nullable(),
  risks: z.array(z.string()).default([]),
  metrics: z.record(z.string(), z.unknown()).default({}),
  rejected: z.array(z.string()).default([]),
});
export type DecisionEntry = z.infer<typeof DecisionEntrySchema>;

export const DecisionLogFileSchema = z.object({
  decisions: z.array(DecisionEntrySchema).default([]),
});
export type DecisionLogFile = z.infer<typeof DecisionLogFileSchema>;

export const MAX_DECISIONS = 100 as const;

export function emptyDecisionLog(): DecisionLogFile {
  return { decisions: [] };
}

/** Sanitizes free-form strings — mirrors decision-log.js:24. */
export function sanitizeDecisionText(value: string | null | undefined, maxLen = 280): string | null {
  if (value == null) return null;
  const cleaned = String(value).replace(/\s+/g, " ").trim().slice(0, maxLen);
  return cleaned || null;
}
