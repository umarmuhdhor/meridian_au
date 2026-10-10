import type { DecisionLogRepo } from "../../../ports/decision-log.js";
import type { Logger } from "../../../ports/logger.js";
import {
  DecisionLogFileSchema,
  emptyDecisionLog,
  type DecisionEntry,
  type DecisionLogFile,
} from "../../../domain/schemas/decision.js";
import { formatLoadError, readJsonValidated, writeJsonAtomic, type LoadError } from "./atomic-write.js";
import { err, ok, type Result } from "../../../shared/result.js";

export interface JsonDecisionLogOptions {
  filePath: string;
  logger: Logger;
}

export function createJsonDecisionLog(opts: JsonDecisionLogOptions): DecisionLogRepo {
  const { filePath, logger } = opts;

  async function loadOrEmpty(): Promise<Result<DecisionLogFile, LoadError>> {
    const r = await readJsonValidated(filePath, DecisionLogFileSchema);
    if (r.ok) return r;
    if (r.error.kind === "not_found") return ok(emptyDecisionLog());
    logger.error("decision-log", formatLoadError(r.error));
    return err(r.error);
  }

  return {
    async load() {
      return loadOrEmpty();
    },

    async append(entry: DecisionEntry) {
      const r = await loadOrEmpty();
      const file = r.ok ? r.value : emptyDecisionLog();
      // Uncapped since 2026-09-29: the 100-entry ring dropped deploy reasons within
      // about a day (most entries are `skip`), so "why did we buy X" was unanswerable.
      // ~80 entries/day × ~500 B ≈ 1.2 MB/month — cheap to keep.
      file.decisions.unshift(entry);
      await writeJsonAtomic(filePath, file);
    },

    async recent(limit = 10) {
      const r = await loadOrEmpty();
      if (!r.ok) return [];
      return r.value.decisions.slice(0, limit);
    },
  };
}
