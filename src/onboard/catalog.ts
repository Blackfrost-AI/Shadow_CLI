import type { ProviderName } from '../provider/index.js';

/**
 * Curated catalog of major model providers for onboarding. Each preset maps to
 * one of Shadow's two adapters (`anthropic` = Anthropic Messages API,
 * `openai` = OpenAI-compatible Chat Completions) plus a base URL, a sensible
 * default model, and how to authenticate. The user can always override the model.
 */
export interface ProviderPreset {
  /** Catalog key (also the credentials-store key). */
  id: string;
  label: string;
  /** Which Shadow adapter speaks to it. */
  adapter: ProviderName; // 'anthropic' | 'openai'
  /** Fixed base URL, or undefined when the user must supply one (local/custom). */
  baseUrl?: string;
  /** Suggested default model id. */
  defaultModel: string;
  /** cloud = needs an API key; local = base URL only (key optional); custom = ask everything. */
  kind: 'cloud' | 'local' | 'custom';
  /** Where to get a key (shown as a hint). */
  keyUrl?: string;
  /** Force the user to type a model (no single sensible default). */
  promptModel?: boolean;
  /** Anthropic-compat endpoints take a bearer token (ANTHROPIC_AUTH_TOKEN) rather than x-api-key when self-hosted. */
  bearer?: boolean;
  /** Placeholder entry shown but not selectable yet (no endpoint wired — deliberate). */
  comingSoon?: boolean;
}

export const PROVIDERS: ProviderPreset[] = [
  {
    id: 'anthropic',
    label: 'Anthropic (Claude)',
    adapter: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    defaultModel: 'claude-opus-4-8',
    kind: 'cloud',
    keyUrl: 'https://console.anthropic.com/settings/keys',
  },
  {
    id: 'openai',
    label: 'OpenAI (GPT)',
    adapter: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-5.1', // reasoning model — Shadow sends max_completion_tokens + reasoning_effort
    kind: 'cloud',
    keyUrl: 'https://platform.openai.com/api-keys',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter (many models)',
    adapter: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'anthropic/claude-3.5-sonnet',
    kind: 'cloud',
    keyUrl: 'https://openrouter.ai/keys',
    promptModel: true,
  },
  {
    id: 'groq',
    label: 'Groq (fast Llama/Mixtral)',
    adapter: 'openai',
    baseUrl: 'https://api.groq.com/openai/v1',
    defaultModel: 'llama-3.3-70b-versatile',
    kind: 'cloud',
    keyUrl: 'https://console.groq.com/keys',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    adapter: 'openai',
    baseUrl: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-chat',
    kind: 'cloud',
    keyUrl: 'https://platform.deepseek.com/api_keys',
  },
  {
    id: 'mistral',
    label: 'Mistral',
    adapter: 'openai',
    baseUrl: 'https://api.mistral.ai/v1',
    defaultModel: 'mistral-large-latest',
    kind: 'cloud',
    keyUrl: 'https://console.mistral.ai/api-keys',
  },
  {
    id: 'xai',
    label: 'xAI (Grok)',
    adapter: 'openai',
    baseUrl: 'https://api.x.ai/v1',
    defaultModel: 'grok-4',
    kind: 'cloud',
    keyUrl: 'https://console.x.ai',
  },
  {
    id: 'gemini',
    label: 'Google Gemini (OpenAI-compatible)',
    adapter: 'openai',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    defaultModel: 'gemini-2.0-flash',
    kind: 'cloud',
    keyUrl: 'https://aistudio.google.com/apikey',
  },
  {
    id: 'together',
    label: 'Together AI',
    adapter: 'openai',
    baseUrl: 'https://api.together.xyz/v1',
    defaultModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
    kind: 'cloud',
    keyUrl: 'https://api.together.xyz/settings/api-keys',
    promptModel: true,
  },
  {
    // Defaults to the GLM Coding Plan endpoint (what Z.ai sells for coding agents); a pay-as-you-go
    // general-API key uses https://api.z.ai/api/paas/v4 instead — editable at the base-URL prompt.
    id: 'zai',
    label: 'Z.ai (GLM Coding Plan)',
    adapter: 'openai',
    baseUrl: 'https://api.z.ai/api/coding/paas/v4',
    defaultModel: 'glm-4.6',
    kind: 'cloud',
    keyUrl: 'https://z.ai/manage-apikey/apikey-list',
  },
  {
    id: 'ollama',
    label: 'Ollama (local, OpenAI API)',
    adapter: 'openai',
    baseUrl: 'http://localhost:11434/v1',
    defaultModel: 'llama3.1',
    kind: 'local',
    promptModel: true,
  },
  {
    id: 'ollama-anthropic',
    label: 'Ollama / proxy (Anthropic API)',
    adapter: 'anthropic',
    baseUrl: 'http://localhost:11434',
    defaultModel: 'llama3.1',
    kind: 'local',
    bearer: true,
    promptModel: true,
  },
  {
    id: 'lmstudio',
    label: 'LM Studio (local)',
    adapter: 'openai',
    baseUrl: 'http://localhost:1234/v1',
    defaultModel: 'local-model',
    kind: 'local',
    promptModel: true,
  },
  {
    id: 'custom',
    label: 'Custom endpoint (you supply everything)',
    adapter: 'openai',
    defaultModel: '',
    kind: 'custom',
    promptModel: true,
  },
];

export function findPreset(id: string): ProviderPreset | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

// ── first-run mode chooser ────────────────────────────────────────────────────

/** The three doors of first-run: run a model file, talk to a local server, or use a cloud key. */
export type OnboardMode = 'file' | 'server' | 'cloud';

/** The catalog subset shown for a chosen mode. 'file' has no provider menu (it prompts for a
 *  .gguf path instead); 'custom' appears under BOTH server and cloud — a self-hosted endpoint
 *  is legitimately either. Pure + unit-tested. */
export function providersForMode(mode: OnboardMode): ProviderPreset[] {
  if (mode === 'file') return [];
  if (mode === 'server') return PROVIDERS.filter((p) => p.kind === 'local' || p.kind === 'custom');
  return PROVIDERS.filter((p) => p.kind === 'cloud' || p.kind === 'custom');
}
