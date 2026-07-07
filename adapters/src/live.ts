// Live wiring for the Claude adapter (Ring 2). Wraps the REAL Agent SDK `query`
// into the adapter's injected QueryFn. Imported only on the `--live` path — CI and
// the stub path never touch this, so no quota is spent in tests. Kept thin: the
// tested behavior lives in anthropic.ts; this only bridges to the SDK.

import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';

import { createAnthropicAdapter, type AnthropicAdapterOptions, type QueryFn, type SdkMessage } from './anthropic.ts';
import type { AdapterInterface } from 'aal';

/** Adapt the real SDK query to the adapter's QueryFn contract (D-004 flags applied by the adapter). */
const liveQuery: QueryFn = (args) =>
  sdkQuery({
    prompt: args.prompt,
    options: {
      ...(args.options.model !== undefined ? { model: args.options.model } : {}),
      ...(args.options.maxTurns !== undefined ? { maxTurns: args.options.maxTurns } : {}),
      tools: args.options.tools,
      // Always [] (D-004 isolation); cast bridges our vendor-neutral string[] to
      // the SDK's SettingSource[] literal union — an empty array satisfies both.
      settingSources: args.options.settingSources as never[],
      systemPrompt: args.options.systemPrompt,
      cwd: args.options.cwd,
    },
  }) as AsyncIterable<SdkMessage>;

export function createLiveAnthropicAdapter(
  opts: Omit<AnthropicAdapterOptions, 'query'>,
): AdapterInterface {
  return createAnthropicAdapter({ ...opts, query: liveQuery });
}
