import { describe, it, expect } from "vitest";
import { z } from "zod";
import { defineTool } from "../../src/app/tools/define-tool.js";
import { createRegistry } from "../../src/app/tools/registry.js";
import { generateOpenAiToolSchemas } from "../../src/app/tools/generate-openai-schemas.js";

const tool = defineTool({
  name: "search",
  description: "Search for something.",
  args: z.object({
    query: z.string().describe("what to look for"),
    limit: z.number().int().positive().max(100).default(10),
  }),
  result: z.object({ hits: z.array(z.string()) }),
  execute: () => ({ hits: [] }),
});

describe("generateOpenAiToolSchemas", () => {
  it("emits the OpenAI tools[] shape", () => {
    const schemas = generateOpenAiToolSchemas(createRegistry([tool]));
    expect(schemas).toHaveLength(1);
    const first = schemas[0];
    expect(first).toBeDefined();
    if (!first) return;
    expect(first.type).toBe("function");
    expect(first.function.name).toBe("search");
    expect(first.function.description).toBe("Search for something.");
    const params = first.function.parameters as {
      type?: string;
      properties?: Record<string, { type?: string; description?: string }>;
      required?: string[];
    };
    expect(params.type).toBe("object");
    expect(params.properties?.query?.type).toBe("string");
    expect(params.properties?.query?.description).toBe("what to look for");
    expect(params.required).toContain("query");
  });

  it("strips $schema and definitions from parameters", () => {
    const schemas = generateOpenAiToolSchemas(createRegistry([tool]));
    const params = schemas[0]?.function.parameters as Record<string, unknown>;
    expect(params.$schema).toBeUndefined();
    expect(params.definitions).toBeUndefined();
    expect(params.$defs).toBeUndefined();
  });
});

describe("generateOpenAiToolSchemas — exclusive bounds", () => {
  it("emits numeric exclusiveMinimum, never the OpenAPI 3.0 boolean form", () => {
    const [schema] = generateOpenAiToolSchemas(createRegistry([tool]));
    const limit = (schema?.function.parameters as { properties: Record<string, Record<string, unknown>> })
      .properties.limit;
    expect(limit?.exclusiveMinimum).toBe(0);
    expect(limit).not.toHaveProperty("minimum");
    expect(limit?.maximum).toBe(100);
    expect(JSON.stringify(schema)).not.toContain('"exclusiveMinimum":true');
  });
});
