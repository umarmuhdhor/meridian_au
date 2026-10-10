import type { LlmConfig } from "../schemas/config.js";

export type LearningTier = "normal" | "important";

/**
 * Which closes deserve the expensive reviewer: losses at or below
 * `learningImportantLossPct`. Those are the ones a lesson exists to prevent, and where a
 * vague or wrong lesson costs the most. Wins and small losses get the normal model.
 */
export function learningTier(llm: Pick<LlmConfig, "learningImportantLossPct">, pnlPct: number): LearningTier {
  return pnlPct <= llm.learningImportantLossPct ? "important" : "normal";
}

/**
 * Pure — the model for one learning call. Empty settings fall through:
 * important → learningImportantModel || learningModel || managementModel;
 * normal    → learningModel || managementModel.
 */
export function learningModelFor(
  llm: Pick<LlmConfig, "learningModel" | "learningImportantModel" | "learningImportantLossPct" | "managementModel">,
  pnlPct: number,
): { model: string; tier: LearningTier } {
  const tier = learningTier(llm, pnlPct);
  const normal = llm.learningModel.trim() || llm.managementModel;
  const model = tier === "important" ? llm.learningImportantModel.trim() || normal : normal;
  return { model, tier };
}
