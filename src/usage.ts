// usage.ts — token usage and cost, per turn and per run.
//
// FIRST PRINCIPLES: an agent loop calls the model once per turn, and every
// call re-sends the system prompt, the tool schemas and the whole history.
// So cost is not "one price per run" — it is the sum over turns, and the
// input part grows as the conversation grows. You can't reason about that
// (or about caching, thinking or model choice) without measuring it, which is
// what the API's `usage` field on every response is for. This file turns it
// into numbers the trace can carry.

export interface Usage {
  /** Uncached input tokens (full price). */
  inputTokens: number;
  outputTokens: number;
  /** Input served from the prompt cache (~0.1x input price). */
  cacheReadTokens: number;
  /** Input written to the prompt cache (~1.25x input price, 5-minute cache). */
  cacheWriteTokens: number;
}

export const emptyUsage = (): Usage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
});

/** The fields of the SDK's `response.usage` we read (cache fields can be null/absent). */
interface ApiUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

export function fromApiUsage(usage: ApiUsage): Usage {
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
  };
}

export function addUsage(total: Usage, turn: Usage): void {
  total.inputTokens += turn.inputTokens;
  total.outputTokens += turn.outputTokens;
  total.cacheReadTokens += turn.cacheReadTokens;
  total.cacheWriteTokens += turn.cacheWriteTokens;
}

/**
 * USD per million tokens (input, output). Anthropic list prices as cached
 * 2026-09-25 — prices change, so treat these as an estimate and check the
 * pricing page before relying on them. Unknown models return no estimate
 * rather than a wrong one.
 */
const PRICES_PER_MTOK: Record<string, { input: number; output: number }> = {
  "claude-haiku-4-5": { input: 1, output: 5 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-opus-5-5": { input: 4, output: 20 },
  "claude-opus-5": { input: 5, output: 25 },
};

const CACHE_READ_MULTIPLIER = 0.1;
const CACHE_WRITE_MULTIPLIER = 1.25;

/** Estimated USD cost, or null if we don't know the model's price. */
export function estimateCostUsd(model: string, usage: Usage): number | null {
  // Tolerate dated ids like `claude-haiku-4-5-20251001`.
  const price = PRICES_PER_MTOK[model.replace(/-\d{8}$/, "")];
  if (!price) return null;
  const inputUnits =
    usage.inputTokens +
    usage.cacheReadTokens * CACHE_READ_MULTIPLIER +
    usage.cacheWriteTokens * CACHE_WRITE_MULTIPLIER;
  return (inputUnits * price.input + usage.outputTokens * price.output) / 1_000_000;
}

/** "$0.0123" for display; "unknown" when the model has no known price. */
export function formatCost(cost: number | null): string {
  return cost === null ? "unknown (no price for this model)" : `$${cost.toFixed(4)}`;
}
