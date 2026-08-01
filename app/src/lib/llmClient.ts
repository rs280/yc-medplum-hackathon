import 'server-only';
import Anthropic from '@anthropic-ai/sdk';
import { CHAT_MODELS, modelOptionFromSlug, type ChatModelOption } from './models';

/**
 * The app's single LLM client. OpenRouter speaks the Anthropic Messages API
 * at /api/v1/messages, so one SDK serves both routes; OpenRouter wins when
 * both keys are set.
 */

const g = globalThis as unknown as { __llmClient?: Anthropic };

// Whether any LLM key is configured (OpenRouter or direct Anthropic).
export function isLlmConfigured(): boolean {
  return Boolean(process.env.OPENROUTER_API_KEY || process.env.ANTHROPIC_API_KEY);
}

// Shared client, or null when no key is configured.
export function getLlmClient(): Anthropic | null {
  if (!isLlmConfigured()) return null;
  g.__llmClient ??= process.env.OPENROUTER_API_KEY
    ? new Anthropic({
        apiKey: process.env.OPENROUTER_API_KEY,
        baseURL: 'https://openrouter.ai/api',
        timeout: 120_000,
        maxRetries: 1,
      })
    : new Anthropic({ timeout: 120_000, maxRetries: 1 });
  return g.__llmClient;
}

// OpenRouter requires vendor-prefixed slugs (e.g. anthropic/claude-sonnet-4.5).
export function reasonModelId(): string {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_MODEL || 'anthropic/claude-sonnet-4.5';
  return process.env.ANTHROPIC_MODEL || 'claude-opus-4-8';
}

// Chat can run a different (cheaper/faster) model than the reasoning pipeline.
export function chatModelId(): string {
  if (process.env.OPENROUTER_API_KEY) {
    return process.env.OPENROUTER_CHAT_MODEL || process.env.OPENROUTER_MODEL || 'anthropic/claude-sonnet-4.5';
  }
  return process.env.ANTHROPIC_CHAT_MODEL || 'claude-opus-4-8';
}

/**
 * Models the copilot picker may offer. Empty without OpenRouter, since the
 * catalog uses OpenRouter's vendor-prefixed slugs and direct Anthropic ids
 * come from env alone.
 */
export function chatModelOptions(): ChatModelOption[] {
  if (!process.env.OPENROUTER_API_KEY) return [];

  const overrides = (process.env.OPENROUTER_MODELS ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  const catalog = new Map(CHAT_MODELS.map((model) => [model.id, model]));
  const ids = overrides.length > 0 ? overrides : CHAT_MODELS.map((model) => model.id);
  const options = ids.map((id) => catalog.get(id) ?? modelOptionFromSlug(id));

  // The configured default is always selectable, even when it isn't catalogued.
  const fallback = chatModelId();
  if (!options.some((model) => model.id === fallback)) options.unshift(modelOptionFromSlug(fallback));
  return options;
}

// Validate a picker selection at the API boundary; unknown ids fall back to the default.
export function resolveChatModel(requested?: string): string {
  if (!requested) return chatModelId();
  return chatModelOptions().some((model) => model.id === requested) ? requested : chatModelId();
}
