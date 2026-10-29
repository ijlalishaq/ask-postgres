import type { Usage } from "agent-guardrails/src/index.ts";

/**
 * USD per million tokens, Anthropic first-party API, October 2026. Haiku 5.5 bills prompts over
 * 100K tokens at a higher rate; the threshold counts cached tokens too.
 */
interface Rate {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

const PRICES: Record<string, { base: Rate; over100k?: Rate }> = {
  "claude-haiku-5-5": {
    base: { input: 0.1, output: 0.5, cacheWrite: 0.125, cacheRead: 0.01 },
    over100k: { input: 0.5, output: 2.5, cacheWrite: 0.625, cacheRead: 0.05 },
  },
  "claude-sonnet-5-5": { base: { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.1 } },
  "claude-opus-5-5": { base: { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 } },
};

export const MODELS = Object.keys(PRICES);

export function promptTokens(u: Usage): number {
  return u.inputTokens + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0);
}

/** Cost of one API call. Throws for an unknown model so a typo can't report $0. */
export function callCost(model: string, u: Usage): number {
  const p = PRICES[model];
  if (!p) throw new Error(`no price for ${model}`);
  const r = p.over100k && promptTokens(u) > 100_000 ? p.over100k : p.base;
  return (
    (u.inputTokens * r.input + u.outputTokens * r.output + (u.cacheWriteTokens ?? 0) * r.cacheWrite + (u.cacheReadTokens ?? 0) * r.cacheRead) /
    1e6
  );
}
