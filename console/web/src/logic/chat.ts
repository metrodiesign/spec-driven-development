// F-Chat display logic (pure, unit-tested). web has no dependency on
// console/backend (like every other logic/*.ts here), so the wire shapes are
// duplicated, not imported. The live WS stream itself is browser-verified
// (task 12); this file is the deterministic event-folding part.

export function chatWsUrl(ticket: string): string {
  return `/api/chat/ws?ticket=${encodeURIComponent(ticket)}`;
}

export type ChatServerEvent =
  | { type: 'stream_delta'; text: string }
  | { type: 'tool_card'; toolUseId: string; name: string; input: Record<string, unknown> }
  | { type: 'approval_request'; toolUseId: string; name: string; input: Record<string, unknown> }
  | { type: 'error'; message: string }
  | { type: 'done'; sdkSessionId: string | null };

export interface ChatUiMessage {
  role: 'user' | 'assistant' | 'error';
  text: string;
}
export interface ChatUiToolCall {
  toolUseId: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ChatUiState {
  messages: ChatUiMessage[];
  toolCards: ChatUiToolCall[];
  pendingApprovals: ChatUiToolCall[];
}

export const initialChatUiState: ChatUiState = { messages: [], toolCards: [], pendingApprovals: [] };

/** Folds one server event into UI state — tool_card (informational, always
 *  shown) and approval_request (actionable, blocks the SDK) are separate
 *  signals even for the SAME tool call (design.md G / REQ-18.1 vs 18.2). */
export function applyServerEvent(state: ChatUiState, event: ChatServerEvent): ChatUiState {
  switch (event.type) {
    case 'stream_delta':
      return { ...state, messages: [...state.messages, { role: 'assistant', text: event.text }] };
    case 'tool_card':
      return { ...state, toolCards: [...state.toolCards, { toolUseId: event.toolUseId, name: event.name, input: event.input }] };
    case 'approval_request':
      return { ...state, pendingApprovals: [...state.pendingApprovals, { toolUseId: event.toolUseId, name: event.name, input: event.input }] };
    case 'error':
      return { ...state, messages: [...state.messages, { role: 'error', text: event.message }] };
    case 'done':
      return state;
  }
}

/** Optimistic client-side removal on click — a stale/unknown id is a safe
 *  no-op on the backend, so no round-trip confirmation is needed. */
export function resolveApproval(state: ChatUiState, toolUseId: string): ChatUiState {
  return { ...state, pendingApprovals: state.pendingApprovals.filter((p) => p.toolUseId !== toolUseId) };
}

export function appendUserMessage(state: ChatUiState, text: string): ChatUiState {
  return { ...state, messages: [...state.messages, { role: 'user', text }] };
}
