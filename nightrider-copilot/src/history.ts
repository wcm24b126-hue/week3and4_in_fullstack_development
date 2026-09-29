import * as vscode from "vscode";
import { getConfig } from "./config";
import type { Conversation } from "./types";

const CONVERSATIONS_KEY = "nightrider.conversations";
const ACTIVE_KEY = "nightrider.activeConversation";

export class HistoryStore implements vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  /**
   * Memory is the source of truth and the memento is a write-through mirror.
   * Without this, turning `saveHistory` off would make every read return
   * nothing and the view would blank itself on the next refresh.
   */
  private _conversations: Conversation[] | undefined;
  private _activeId: string | undefined;
  // `undefined` means "not loaded yet" for the active id, so clearing needs
  // its own flag; otherwise a cleared value would just be re-read from disk.
  private _activeLoaded = false;

  constructor(private readonly _global: vscode.Memento) {}

  private get _cache(): Conversation[] {
    if (!this._conversations) {
      this._conversations = [...(this._global.get<Conversation[]>(CONVERSATIONS_KEY, []) ?? [])];
    }
    return this._conversations;
  }

  private get _active(): string | undefined {
    if (!this._activeLoaded) {
      this._activeId = this._global.get<string | undefined>(ACTIVE_KEY);
      this._activeLoaded = true;
    }
    return this._activeId;
  }

  private set _active(value: string | undefined) {
    this._activeId = value;
    this._activeLoaded = true;
  }

  list(): Conversation[] {
    return [...this._cache].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get(id: string): Conversation | undefined {
    return this._cache.find((c) => c.id === id);
  }

  activeId(): string | undefined {
    return this._active;
  }

  active(): Conversation | undefined {
    const id = this._active;
    return id ? this.get(id) : undefined;
  }

  create(): Conversation {
    const now = Date.now();
    const conversation: Conversation = {
      id: `${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      title: "New chat",
      createdAt: now,
      updatedAt: now,
      messages: []
    };
    this._cache.unshift(conversation);
    this._active = conversation.id;
    this.persist();
    this._onDidChange.fire();
    return conversation;
  }

  ensureActive(): Conversation {
    const existing = this.active();
    if (existing) {
      return existing;
    }
    const recent = this.list()[0];
    if (recent) {
      this._active = recent.id;
      this.persist();
      return recent;
    }
    return this.create();
  }

  save(conversation: Conversation): void {
    conversation.updatedAt = Date.now();
    if (conversation.messages.length > 0 && conversation.title === "New chat") {
      const firstUser = conversation.messages.find((m) => m.role === "user");
      if (firstUser) {
        conversation.title = deriveTitle(firstUser.content);
      }
    }

    this._active = conversation.id;
    this.persist();
    this._onDidChange.fire();
  }

  delete(id: string): void {
    const index = this._cache.findIndex((c) => c.id === id);
    if (index !== -1) {
      this._cache.splice(index, 1);
    }
    if (this._active === id) {
      this._active = this._cache[0]?.id;
    }
    this.persist();
    this._onDidChange.fire();
  }

  clear(): void {
    this._conversations = [];
    this._active = undefined;
    this.persist();
    this._onDidChange.fire();
  }

  private persist(): void {
    const cfg = getConfig();
    const sorted = [...this._cache].sort((a, b) => b.updatedAt - a.updatedAt);
    this._conversations = sorted;

    if (!cfg.saveHistory) {
      // Still record the active id so the current chat survives a reload.
      void this._global.update(ACTIVE_KEY, this._active);
      return;
    }
    void this._global.update(CONVERSATIONS_KEY, sorted.slice(0, cfg.maxSavedConversations));
    void this._global.update(ACTIVE_KEY, this._active);
  }

  /** Turns a stored conversation back into a clean, non-pending message list. */
  static sanitize(conversation: Conversation): Conversation {
    return {
      ...conversation,
      messages: conversation.messages.map((m) => ({
        ...m,
        pending: false,
        error: undefined,
        mentions: m.mentions ? [...m.mentions] : undefined
      }))
    };
  }

  dispose(): void {
    this._onDidChange.dispose();
  }
}

export function newMessageId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function deriveTitle(text: string): string {
  const line = text.trim().split("\n").find((l) => l.trim().length > 0) ?? "New chat";
  const cleaned = line.replace(/^#+\s*/, "").replace(/\s+/g, " ").trim();
  return cleaned.length > 48 ? `${cleaned.slice(0, 47)}…` : cleaned || "New chat";
}

export function messageCounts(conversation: Conversation): { messages: number; first: string } {
  const first = conversation.messages.find((m) => m.role === "user");
  return {
    messages: conversation.messages.length,
    first: first ? deriveTitle(first.content) : conversation.title
  };
}
