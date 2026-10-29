/** Plain single-turn calls, for the strategies that don't use tools. */
import Anthropic from "@anthropic-ai/sdk";
import type { Usage } from "agent-guardrails/src/index.ts";

export interface Turn {
  role: "user" | "assistant";
  content: string;
}

export interface Completion {
  text: string;
  usage: Usage;
}

let client: Anthropic | undefined;

export async function complete(model: string, messages: Turn[], system?: string): Promise<Completion> {
  client ??= new Anthropic();
  const res = await client.messages.create({
    model,
    max_tokens: 16_000,
    ...(system ? { system } : {}),
    messages,
  });
  const text = res.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
  const u = res.usage;
  return {
    text,
    usage: {
      inputTokens: u.input_tokens,
      outputTokens: u.output_tokens,
      cacheReadTokens: u.cache_read_input_tokens ?? 0,
      cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
    },
  };
}
