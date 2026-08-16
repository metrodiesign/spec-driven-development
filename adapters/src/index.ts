// Ring 2 public surface (adapters — wire-format translation only, INV-8).
// Vendor names are legal HERE and only here.
export const RING = 2 as const;

export {
  describeAnthropicAdapter,
  describeCodexAdapter,
  describeReasoningCliAdapter,
  type AdapterDescriptor,
  type AdapterTransport,
} from './descriptors.ts';

export {
  createAnthropicAdapter,
  type AnthropicAdapterOptions,
  type QueryFn,
  type SdkMessage,
} from './anthropic.ts';
export { createLiveAnthropicAdapter } from './live.ts';
export {
  createCodexAdapter,
  parseCodexEvents,
  sumCodexUsage,
  DEFAULT_KILL_TIMEOUT_MS,
  type CodexAdapterOptions,
  type CodexEvent,
  type CodexExecResult,
  type ExecFn,
} from './codex.ts';
export { createLiveCodexAdapter, buildCodexArgv, CODEX_STDIO } from './codex-live.ts';
export {
  createOpenAICompatibleAdapter,
  buildGlmRequestBody,
  parseGlmHttpBody,
  resolveGlmEndpointConfig,
  GLM_CONTEXT_WINDOW_TOKENS,
  GLM_DEFAULT_BASE_URL,
  type OpenAICompatibleAdapterOptions,
  type GlmTransport,
  type GlmTransportResult,
  type GlmReasoningEffort,
} from './openai-compatible.ts';
export { createLiveGlmAdapter, GLM_DEFAULT_MODEL, GLM_DEFAULT_TIMEOUT_MS, type LiveGlmOptions } from './openai-compatible-live.ts';
export { linkCallControl, providerEnvironment } from './control.ts';
export {
  createReasoningCliAdapter,
  type ReasoningCliAdapterOptions,
  type ReasoningCliExec,
  type ReasoningCliResult,
} from './reasoning-cli.ts';
export {
  buildGeminiReviewArgv,
  buildOpenCodeReviewArgv,
  buildOpenCodeGlmEnv,
  createLiveGeminiAdapter,
  createLiveOpenCodeDeepSeekAdapter,
  createLiveOpenCodeGlmAdapter,
  OPENCODE_GLM_DEFAULT_MODEL,
  opencodeErrorDetail,
  resolveOpenCodeAuthStore,
  resolveOpenCodeModelCatalog,
  type OpenCodeGlmOptions,
} from './reasoning-cli-live.ts';
// Shared Ring-2 wire helpers (INV-8) — reused by both adapters and any new lineage.
export { buildProposePrompt, classifyAdapterError, normalizeActions, unfence } from './wire.ts';
