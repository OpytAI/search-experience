/**
 * Build AgentOS host-tool definitions for mc.create / restore.
 * Uses dynamic import of mc-core so unit tests do not load Wasm.
 */

import { HOST_TOOL_ADDRESSES, HOST_TOOL_NAMES } from "../protocol/versions.js";
import type { SearchEmbedBatchInput, SearchExtractInput, SearchFetchInput } from "../protocol/host-tools.js";
import { runSearchFetch, type FetchToolOptions } from "./fetch.js";
import { runSearchExtract } from "./extract.js";
import { runSearchEmbedBatch, type EmbedToolState } from "./embed.js";

export interface HostToolRuntime {
  fetchOptions: FetchToolOptions;
  embed: EmbedToolState;
}

/** Minimal shape used from mc-core without a static type import. */
export interface McToolModule {
  tool: (spec: {
    name: string;
    address?: string;
    description?: string;
    input?: unknown;
    annotations?: Record<string, unknown>;
    run: (args: Record<string, unknown>, ctx: unknown) => Promise<unknown> | unknown;
  }) => unknown;
  z: {
    object: (shape: Record<string, unknown>) => unknown;
    string: () => { optional: () => unknown };
    number: () => { optional: () => unknown; int: () => { optional: () => unknown } };
    array: (inner: unknown) => unknown;
    enum: (values: readonly string[]) => { optional: () => unknown };
  };
}

export function buildSearchHostTools(mc: McToolModule, runtime: HostToolRuntime): unknown[] {
  const { tool, z } = mc;

  const fetchTool = tool({
    name: HOST_TOOL_NAMES.fetch,
    address: HOST_TOOL_ADDRESSES.fetch,
    description: "Bounded same-origin fetch for site-search crawl (no credentials).",
    annotations: { read_only: true, open_world: false },
    input: z.object({
      url: z.string(),
      maxBytes: z.number().int().optional(),
      timeoutMs: z.number().int().optional(),
      userAgent: z.string().optional(),
    }),
    async run(args) {
      return runSearchFetch(args as unknown as SearchFetchInput, runtime.fetchOptions);
    },
  });

  const extractTool = tool({
    name: HOST_TOOL_NAMES.extract,
    address: HOST_TOOL_ADDRESSES.extract,
    description: "Extract title, blocks, and links from HTML for search indexing.",
    annotations: { read_only: true },
    input: z.object({
      url: z.string(),
      html: z.string(),
    }),
    run(args) {
      return runSearchExtract(args as unknown as SearchExtractInput);
    },
  });

  const embedTool = tool({
    name: HOST_TOOL_NAMES.embedBatch,
    address: HOST_TOOL_ADDRESSES.embedBatch,
    description: "Batch Mixedbread UINT8 embeddings for document/query text.",
    annotations: { read_only: true },
    input: z.object({
      texts: z.array(z.string()),
      kind: z.enum(["document", "query"]).optional(),
    }),
    async run(args) {
      return runSearchEmbedBatch(runtime.embed, args as unknown as SearchEmbedBatchInput);
    },
  });

  return [fetchTool, extractTool, embedTool];
}
