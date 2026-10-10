import { zodToJsonSchema } from "zod-to-json-schema";
import type { ToolRegistry } from "./registry.js";

export interface OpenAiToolSchema {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/**
 * Walks the registry, emits OpenAI's `tools` array shape from each tool's Zod args schema.
 * Replaces the hand-maintained `tools/definitions.js`. Adding a tool = writing one file;
 * the LLM contract updates automatically. No possibility of drift.
 */
export function generateOpenAiToolSchemas(registry: ToolRegistry): OpenAiToolSchema[] {
  return registry.all().map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: normalizeExclusiveBounds(
        stripJsonSchemaMeta(
          zodToJsonSchema(tool.args, { target: "openApi3", $refStrategy: "none" }) as Record<string, unknown>,
        ),
      ) as Record<string, unknown>,
    },
  }));
}

/**
 * The openApi3 target emits OpenAPI 3.0's boolean bounds (`{minimum:0, exclusiveMinimum:true}`
 * for `.positive()`). Strict JSON-Schema validators upstream (glm-5.3 via BandelAI, 2026-10-05)
 * reject the whole request as "invalid parameters" — every screening cycle failed. Rewrite to
 * the draft-6+ numeric form (`{exclusiveMinimum:0}`), which every provider accepts.
 */
function normalizeExclusiveBounds(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(normalizeExclusiveBounds);
  if (node === null || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) out[k] = normalizeExclusiveBounds(v);
  for (const [flag, bound] of [["exclusiveMinimum", "minimum"], ["exclusiveMaximum", "maximum"]] as const) {
    if (typeof out[flag] !== "boolean") continue;
    if (out[flag] === true && typeof out[bound] === "number") {
      out[flag] = out[bound];
      delete out[bound];
    } else {
      delete out[flag];
    }
  }
  return out;
}

/** Drop `$schema`/`definitions` OpenAI doesn't accept in `parameters`. */
function stripJsonSchemaMeta(schema: Record<string, unknown>): Record<string, unknown> {
  const clone: Record<string, unknown> = { ...schema };
  delete clone.$schema;
  delete clone.definitions;
  delete clone.$defs;
  return clone;
}
