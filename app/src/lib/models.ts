/**
 * Catalog of chat models the copilot may run on. Shared by the client-side
 * picker and the /api/chat route, which only accepts ids listed here. Ids are
 * OpenRouter's vendor-prefixed slugs; OPENROUTER_MODELS overrides the list.
 *
 * Every entry supports tool calling — the copilot's agent loop needs it.
 * Ordered by vendor; the picker groups on the vendor field.
 */

export interface ChatModelOption {
  id: string;
  label: string;
  vendor: string;
  note: string;
}

export const CHAT_MODELS: ChatModelOption[] = [
  // Anthropic — the reasoning pipeline is tuned against Claude, so these lead.
  {
    id: 'anthropic/claude-sonnet-5',
    label: 'Sonnet 5',
    vendor: 'Anthropic',
    note: 'Balanced default — near-Opus quality, low cost',
  },
  {
    id: 'anthropic/claude-opus-5',
    label: 'Opus 5',
    vendor: 'Anthropic',
    note: 'Deepest reasoning for hard appeals',
  },
  {
    id: 'anthropic/claude-haiku-4.5',
    label: 'Haiku 4.5',
    vendor: 'Anthropic',
    note: 'Cheapest and fastest for status checks',
  },
  {
    id: 'anthropic/claude-sonnet-4.5',
    label: 'Sonnet 4.5',
    vendor: 'Anthropic',
    note: 'Previous-generation Sonnet',
  },
  {
    id: 'anthropic/claude-fable-5',
    label: 'Fable 5',
    vendor: 'Anthropic',
    note: 'Most capable — long-horizon agent runs',
  },

  // OpenAI
  {
    id: 'openai/gpt-5.6-sol',
    label: 'GPT-5.6 Sol',
    vendor: 'OpenAI',
    note: 'Flagship — cross-vendor comparison',
  },
  {
    id: 'openai/gpt-5.6-terra',
    label: 'GPT-5.6 Terra',
    vendor: 'OpenAI',
    note: 'Mid-tier, cheaper cross-check',
  },
  {
    id: 'openai/gpt-5.6-luna',
    label: 'GPT-5.6 Luna',
    vendor: 'OpenAI',
    note: 'Very cheap — high-volume triage',
  },

  // Google
  {
    id: 'google/gemini-3.1-pro-preview',
    label: 'Gemini 3.1 Pro',
    vendor: 'Google',
    note: 'Long-context alternative (preview)',
  },
  {
    id: 'google/gemini-3.5-flash',
    label: 'Gemini 3.5 Flash',
    vendor: 'Google',
    note: 'Fast 1M-context option',
  },

  // Other frontier labs
  {
    id: 'x-ai/grok-4.5',
    label: 'Grok 4.5',
    vendor: 'xAI',
    note: 'Cheap output tokens for long drafts',
  },
  {
    id: 'moonshotai/kimi-k3',
    label: 'Kimi K3',
    vendor: 'Moonshot',
    note: 'Strong agentic tool use',
  },
  {
    id: 'deepseek/deepseek-v4-pro',
    label: 'DeepSeek V4 Pro',
    vendor: 'DeepSeek',
    note: 'Lowest cost per appeal drafted',
  },
  {
    id: 'qwen/qwen3.7-max',
    label: 'Qwen3.7 Max',
    vendor: 'Qwen',
    note: 'Qwen flagship, 1M context',
  },
  {
    id: 'z-ai/glm-5.2',
    label: 'GLM-5.2',
    vendor: 'Z.ai',
    note: 'Budget frontier model',
  },
  {
    id: 'mistralai/mistral-large-2512',
    label: 'Mistral Large',
    vendor: 'Mistral',
    note: 'EU-hosted option',
  },
  {
    id: 'meta-llama/llama-3.3-70b-instruct',
    label: 'Llama 3.3 70B',
    vendor: 'Meta',
    note: 'Open-weights option',
  },
];

// Picker entry for a slug that isn't in the catalog (env-supplied ids).
export function modelOptionFromSlug(id: string): ChatModelOption {
  const [vendor, name = id] = id.includes('/') ? id.split('/') : ['Custom', id];
  return {
    id,
    label: name.replace(/[-_]/g, ' '),
    vendor,
    note: 'Configured via OPENROUTER_MODELS',
  };
}
