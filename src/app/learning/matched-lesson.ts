import type { ChatMessage, LLMClient } from "../../ports/llm-client.js";
import type { PerformanceRecord } from "../../domain/schemas/lesson.js";
import { checkMatch, type MatchBacktest } from "../../domain/rules/lesson-match.js";

/** Completion budget per call. Reasoning models (glm-5.3) think for 1–6k tokens first. */
export const MATCHED_LESSON_MAX_TOKENS = 8000;
/** Extra LLM turns allowed to narrow a MATCH the backtest rejected, before giving up on a lesson. */
export const MATCHED_LESSON_MAX_REFINES = 2;

/** What a reviewer reply must expose for the backtest loop. */
export interface LessonProposal {
  rule: string | null;
  match: string | null;
}

export interface MatchedLessonResult<P extends LessonProposal> {
  /** First reply (narrative fields are taken from here when later turns omit them). */
  first: P;
  /** Last reply the model gave. */
  last: P;
  /** Set when the last proposal passed the backtest. */
  accepted: { rule: string; match: string; backtest: MatchBacktest } | null;
  /** Why the proposal was dropped — too broad / unparseable / refinement failure. */
  rejected: string | null;
}

/**
 * Conversation that turns a reviewer's free-text rule into a NARROW, backtested lesson.
 *
 *   1. Ask. The first reply must be usable (`usable`) and not truncated, else this throws —
 *      a failed call, not the model saying "nothing new"; the caller retries.
 *   2. If it proposes a rule, `checkMatch` it against `history`. A rejected MATCH goes back
 *      to the model with the trades it wrongly caught, up to MATCHED_LESSON_MAX_REFINES
 *      times. A rule that cannot be made narrow is dropped; a failed refinement turn drops
 *      the rule instead of throwing (the review itself already succeeded).
 */
export async function converseForMatchedLesson<P extends LessonProposal>(opts: {
  llm: LLMClient;
  model: string;
  system: string;
  user: string;
  parse: (text: string) => P;
  usable: (p: P) => boolean;
  self: PerformanceRecord;
  outcome: "win" | "loss";
  history: readonly PerformanceRecord[];
  replyFormat: string;
}): Promise<MatchedLessonResult<P>> {
  const messages: ChatMessage[] = [
    { role: "system", content: opts.system },
    { role: "user", content: opts.user },
  ];
  const call = async (): Promise<P> => {
    const res = await opts.llm.chat({
      model: opts.model,
      messages: [...messages],
      temperature: 0.2,
      max_tokens: MATCHED_LESSON_MAX_TOKENS,
    });
    const parsed = opts.parse(res.text ?? "");
    if (res.finish_reason === "length" || !opts.usable(parsed)) {
      throw new Error(`unusable reply (finish_reason=${res.finish_reason ?? "?"}): ${JSON.stringify((res.text ?? "").slice(0, 80))}`);
    }
    messages.push({ role: "assistant", content: res.text ?? "" });
    return parsed;
  };

  const first = await call();
  let last = first;
  for (let refine = 0; ; refine++) {
    if (!last.rule) return { first, last, accepted: null, rejected: null };
    const check = checkMatch(last.match, opts.self, opts.outcome, opts.history);
    if (check.ok) return { first, last, accepted: { rule: last.rule, match: check.match, backtest: check.backtest }, rejected: null };
    if (refine >= MATCHED_LESSON_MAX_REFINES) return { first, last, accepted: null, rejected: check.reason };
    messages.push({
      role: "user",
      content:
        `Your MATCH was rejected: ${check.reason}.\n` +
        "Narrow it: add or tighten a condition that THIS trade meets and those trades do not (compare their entries" +
        " in the OPPOSITE-OUTCOME list). If no visible entry signal separates them, answer LESSON: NONE and MATCH: NONE." +
        ` Reply in the same format: ${opts.replyFormat}.`,
    });
    try {
      last = await call();
    } catch (e) {
      return { first, last, accepted: null, rejected: `refinement failed: ${e instanceof Error ? e.message : String(e)}` };
    }
  }
}

/** Suffix appended to an accepted lesson so the screener sees exactly where it applies. */
export function matchSuffix(match: string, bt: MatchBacktest): string {
  return ` {applies ONLY when: ${match} — history ${bt.wins}W/${bt.losses}L}`;
}
