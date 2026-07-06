// Ring 2 public surface (adapters — wire-format translation only, INV-8).
// Vendor names are legal HERE and only here.
export const RING = 2 as const;

export {
  createAnthropicAdapter,
  type AnthropicAdapterOptions,
  type QueryFn,
  type SdkMessage,
} from './anthropic.ts';
export { createLiveAnthropicAdapter } from './live.ts';
