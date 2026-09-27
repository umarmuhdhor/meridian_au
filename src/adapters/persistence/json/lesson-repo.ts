import type { ListLessonsOptions, LessonRepo } from "../../../ports/lesson-repo.js";
import type { Logger } from "../../../ports/logger.js";
import {
  emptyLessonFile,
  LessonFileSchema,
  type Lesson,
  type LessonFile,
  type PerformanceRecord,
} from "../../../domain/schemas/lesson.js";
import { formatLoadError, readJsonValidated, writeJsonAtomic, type LoadError } from "./atomic-write.js";
import { err, ok, type Result } from "../../../shared/result.js";

export interface JsonLessonRepoOptions {
  filePath: string;
  logger: Logger;
}

export function createJsonLessonRepo(opts: JsonLessonRepoOptions): LessonRepo {
  const { filePath, logger } = opts;

  async function loadOrEmpty(): Promise<Result<LessonFile, LoadError>> {
    const r = await readJsonValidated(filePath, LessonFileSchema);
    if (r.ok) return r;
    if (r.error.kind === "not_found") return ok(emptyLessonFile());
    logger.error("lessons", formatLoadError(r.error));
    return err(r.error);
  }

  return {
    async load() {
      return loadOrEmpty();
    },

    async save(file: LessonFile) {
      await writeJsonAtomic(filePath, file);
    },

    async listLessons(o: ListLessonsOptions = {}): Promise<Lesson[]> {
      const r = await loadOrEmpty();
      if (!r.ok) return [];
      let out = r.value.lessons;
      if (o.role != null) out = out.filter((l) => l.role === o.role || l.role == null);
      if (o.pinned != null) out = out.filter((l) => l.pinned === o.pinned);
      if (o.tag != null) {
        const tag = o.tag;
        out = out.filter((l) => l.tags?.includes(tag));
      }
      return o.limit != null ? out.slice(-o.limit) : out;
    },

    async addLesson(lesson: Lesson) {
      const r = await loadOrEmpty();
      const file = r.ok ? r.value : emptyLessonFile();
      file.lessons.push(lesson);
      await writeJsonAtomic(filePath, file);
    },

    async pinLesson(id: string): Promise<boolean> {
      const r = await loadOrEmpty();
      if (!r.ok) return false;
      const file = r.value;
      const idx = file.lessons.findIndex((l) => l.id === id);
      if (idx === -1) return false;
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const existing = file.lessons[idx]!;
      file.lessons[idx] = { ...existing, pinned: true };
      await writeJsonAtomic(filePath, file);
      return true;
    },

    async unpinLesson(id: string): Promise<boolean> {
      const r = await loadOrEmpty();
      if (!r.ok) return false;
      const file = r.value;
      const idx = file.lessons.findIndex((l) => l.id === id);
      if (idx === -1) return false;
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const existing = file.lessons[idx]!;
      file.lessons[idx] = { ...existing, pinned: false };
      await writeJsonAtomic(filePath, file);
      return true;
    },

    async appendPerformance(perf: PerformanceRecord) {
      const r = await loadOrEmpty();
      const file = r.ok ? r.value : emptyLessonFile();
      file.performance.push(perf);
      await writeJsonAtomic(filePath, file);
    },

    async updatePerformance(position: string, patch: Partial<PerformanceRecord>): Promise<boolean> {
      const r = await loadOrEmpty();
      if (!r.ok) return false;
      const file = r.value;
      const idx = file.performance.findLastIndex((p) => p.position === position);
      if (idx < 0) return false;
      file.performance[idx] = { ...file.performance[idx]!, ...patch };
      await writeJsonAtomic(filePath, file);
      return true;
    },

    async recentPerformance(limit = 50): Promise<PerformanceRecord[]> {
      const r = await loadOrEmpty();
      if (!r.ok) return [];
      return r.value.performance.slice(-limit);
    },
  };
}
