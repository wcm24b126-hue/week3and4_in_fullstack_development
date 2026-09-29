import type { Mode } from "./config";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  mode: Mode;
  createdAt: number;
  /** File paths the user @-mentioned for this turn. */
  mentions?: string[];
  /** Set when the assistant turn failed. */
  error?: string;
  /** True when this turn is still streaming. */
  pending?: boolean;
  /** Model that produced an assistant message. */
  model?: string;
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
}

export interface AttachedFile {
  path: string;
  name: string;
  chars: number;
  truncated: boolean;
}

export interface ContextBundle {
  text: string;
  files: AttachedFile[];
  truncated: boolean;
  symbols: string;
  diagnostics: string;
}

/** Messages the extension host posts into the webview. */
export type HostMessage =
  | { type: "init"; hasKey: boolean; config: ViewConfig; conversation: Conversation | null }
  | { type: "render"; conversation: Conversation | null }
  | { type: "streamStart"; message: ChatMessage }
  | { type: "streamDelta"; messageId: string; text: string }
  | { type: "streamEnd"; message: ChatMessage }
  | { type: "streamCancelled"; messageId: string }
  | { type: "error"; messageId: string; text: string; kind: ErrorKind }
  | { type: "busy"; busy: boolean }
  | { type: "setConfig"; config: ViewConfig }
  | { type: "showNotice"; level: "info" | "warn" | "error"; message: string }
  | { type: "setStatus"; status: ViewStatus }
  | { type: "composer"; text: string; mode: Mode; mentions: string[] }
  | { type: "mentionResults"; files: { path: string; name: string }[] };

export type ErrorKind =
  | "auth"
  | "rate_limit"
  | "network"
  | "server"
  | "timeout"
  | "aborted"
  | "empty"
  | "unknown";

export type QuickActionId =
  | "explain"
  | "fix"
  | "tests"
  | "document"
  | "refactor"
  | "review"
  | "commit";

export interface ViewConfig {
  model: string;
  mode: Mode;
  models: { id: string; label: string; hint: string }[];
  streaming: boolean;
  autoContext: boolean;
  includeCurrentFile: boolean;
  workspaceTrusted: boolean;
  contextChars: number;
}

export interface ViewStatus {
  provider: string;
  model: string;
  copilotInstalled: boolean;
  copilotSignedIn: boolean;
  copilotLimited: boolean;
  hasKey: boolean;
}
