/**
 * InnerThought — LLM-agnostic reasoning client
 *
 * Delegates to a pluggable LLMProvider. Provider is selected via
 * LLM_PROVIDER env var: ollama | openai | anthropic | none
 *
 * Returns null on any error, timeout, or missing config.
 * Callers must always handle null (graceful fallback required).
 */

import { config } from "../utils/config.js";
import {
  type LLMProvider,
  NoopProvider,
  OllamaProvider,
  OpenAIProvider,
  AnthropicProvider,
} from "./LLMProvider.js";

export class InnerThought {
  private readonly provider: LLMProvider;

  constructor(provider?: LLMProvider) {
    this.provider = provider ?? InnerThought.createProvider();
  }

  async reason(prompt: string): Promise<string | null> {
    return this.provider.reason(prompt);
  }

  static createProvider(): LLMProvider {
    const { provider, ollamaUrl, model, openaiKey, anthropicKey, timeoutMs } =
      config.cognition;

    switch (provider) {
      case "openai":
        if (!openaiKey) {
          console.warn(
            "[InnerThought] LLM_PROVIDER=openai but OPENAI_API_KEY is missing — falling back to noop",
          );
          return new NoopProvider();
        }
        return new OpenAIProvider(openaiKey, model, timeoutMs);

      case "anthropic":
        if (!anthropicKey) {
          console.warn(
            "[InnerThought] LLM_PROVIDER=anthropic but ANTHROPIC_API_KEY is missing — falling back to noop",
          );
          return new NoopProvider();
        }
        return new AnthropicProvider(anthropicKey, model, timeoutMs);

      case "none":
        return new NoopProvider();

      case "ollama":
      default:
        return new OllamaProvider(ollamaUrl, model, timeoutMs);
    }
  }
}
