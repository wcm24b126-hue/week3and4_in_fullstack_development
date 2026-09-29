import * as vscode from "vscode";
import { getConfig, updateSetting, type Mode } from "../config";
import { buildContext } from "../context/engine";
import { getFileIndex, invalidateFileIndex, rankFiles } from "../context/fileIndex";
import { HistoryStore, newMessageId } from "../history";
import { LlmError, complete, type ChatMessageIn } from "../llm/client";
import { MODELS, modelLabel } from "../llm/models";
import { QUICK_ACTIONS, systemPrompt } from "../llm/prompts";
import { logError, logInfo, logWarn } from "../logging";
import type { SecretStore } from "../secrets";
import type { ChatMessage, Conversation, HostMessage, QuickActionId, ViewConfig, ViewStatus } from "../types";
import { CodeApplier, runInTerminal } from "../editor/applyCode";
import type { CopilotBridge } from "../copilot/bridge";

type Incoming =
  | { type: "ready" }
  | { type: "send"; text: string; mode: Mode; mentions: string[] }
  | { type: "stop" }
  | { type: "regenerate" }
  | { type: "editMessage"; id: string; text: string }
  | { type: "deleteMessage"; id: string }
  | { type: "newChat" }
  | { type: "loadConversation"; id: string }
  | { type: "deleteConversation"; id: string }
  | { type: "setMode"; mode: Mode }
  | { type: "setModel"; id: string }
  | { type: "command"; id: string }
  | { type: "runQuickAction"; action: QuickActionId }
  | { type: "openFile"; path: string }
  | { type: "codeAction"; action: "copy" | "apply" | "insert" | "preview" | "run"; code: string; language: string }
  | { type: "mentionQuery"; query: string }
  | { type: "feedback"; messageId: string; value: "up" | "down" }
  | { type: "requestState" };

export interface PromptOptions {
  send?: boolean;
  mode?: Mode;
  mentions?: string[];
}

export class ChatViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewType = "nightriderSidebar";

  private _view: vscode.WebviewView | undefined;
  private _abort: AbortController | undefined;
  private _ready = false;
  private _busy = false;
  private _mode: Mode = "chat";
  private _pendingMentions: string[] = [];
  private _prefill = "";
  private _disposables: vscode.Disposable[] = [];

  constructor(
    private readonly _context: vscode.ExtensionContext,
    private readonly _secrets: SecretStore,
    private readonly _history: HistoryStore,
    private readonly _applier: CodeApplier,
    private readonly _copilot: CopilotBridge
  ) {
    this._disposables.push(
      this._secrets.onDidChangeKey(() => void this.pushState()),
      this._copilot.onDidChange(() => void this.pushStatus()),
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        invalidateFileIndex();
        void this.post({ type: "showNotice", level: "info", message: "Workspace folders changed - file index refreshed." });
      })
    );
  }

  get busy(): boolean {
    return this._busy;
  }

  get extensionUri(): vscode.Uri {
    return this._context.extensionUri;
  }

  /** Re-sends config + history + status to the webview. */
  async refreshState(): Promise<void> {
    if (!this._ready) {
      return;
    }
    await this.pushState();
    await this.pushFullHistory();
    await this.pushStatus();
  }

  async loadConversation(id: string): Promise<void> {
    await this._loadConversation(id);
  }

  get ready(): boolean {
    return this._ready;
  }

  async focus(): Promise<void> {
    await vscode.commands.executeCommand(`${ChatViewProvider.viewType}.focus`);
    if (this._view) {
      this._view.show(true);
    }
  }

  /** Queue a prompt in the composer, optionally sending it immediately. */
  async prompt(text: string, options: PromptOptions = {}): Promise<void> {
    this._prefill = text;
    if (options.mentions) {
      this._pendingMentions = options.mentions;
    }
    if (options.mode) {
      this._mode = options.mode;
    }
    await this.focus();

    if (options.send) {
      await this.send(text, this._mode, options.mentions ?? this._pendingMentions);
      this._prefill = "";
      this._pendingMentions = [];
    } else {
      // Forward the mentions, otherwise a Copilot handoff or a quick action
      // would silently drop the files it attached.
      await this.post({
        type: "composer",
        text: this._prefill,
        mode: this._mode,
        mentions: [...this._pendingMentions]
      });
    }
  }

  async runQuickAction(action: QuickActionId): Promise<void> {
    const def = QUICK_ACTIONS[action];
    if (!def) {
      return;
    }
    const editor = vscode.window.activeTextEditor;
    const mentionSelection = !!editor && !editor.selection.isEmpty;
    await this.prompt(def.prompt, {
      send: true,
      mode: action === "commit" ? "terminal" : "chat"
    });
    if (mentionSelection) {
      logInfo(`quick action ${action} scoped to selection`);
    }
  }

  // --- lifecycle -------------------------------------------------------

  async resolveWebviewView(webviewView: vscode.WebviewView): Promise<void> {
    // The view can be resolved again after a hide/show cycle. Drop the previous
    // view-scoped listeners first, otherwise every message would be handled
    // once per resolve and each prompt would run the model multiple times.
    for (const stale of this._disposables) {
      stale.dispose();
    }
    this._disposables = [];

    this._view = webviewView;
    this._disposables.push(
      webviewView.onDidDispose(() => {
        this._view = undefined;
        this._ready = false;
        for (const stale of this._disposables) {
          stale.dispose();
        }
        this._disposables = [];
      })
    );

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this._context.extensionUri, "media")]
    };

    webviewView.webview.html = this._html(webviewView.webview);
    this._disposables.push(
      webviewView.webview.onDidReceiveMessage((raw: unknown) => this._onMessage(raw))
    );
  }

  private _html(webview: vscode.Webview): string {
    const media = vscode.Uri.joinPath(this._context.extensionUri, "media");
    const asUri = (...parts: string[]): vscode.Uri =>
      webview.asWebviewUri(vscode.Uri.joinPath(media, ...parts));
    const n = createNonce();
    const csp = [
      "default-src 'none'",
      `img-src ${webview.cspSource} https: data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${n}'`,
      `font-src ${webview.cspSource}`
    ].join("; ");

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<link nonce="${n}" href="${asUri("styles.css")}" rel="stylesheet">
<title>NightRider</title>
</head>
<body>
  <header class="nr-header">
    <div class="nr-header-row">
      <span class="nr-logo" aria-hidden="true"></span>
      <select id="modelPicker" class="nr-model" title="Active model"></select>
      <button id="statusBtn" class="nr-icon-btn" title="Status and Copilot handoff">
        <span class="nr-dot" id="statusDot"></span>
      </button>
    </div>
    <div class="nr-sub" id="subLine">Not connected</div>
  </header>

  <div class="nr-quickbar" id="quickbar"></div>

  <main id="messages" class="nr-messages" aria-live="polite"></main>

  <div id="notice" class="nr-notice" hidden></div>

  <footer class="nr-composer">
    <div id="mentionBar" class="nr-mentions" hidden></div>
    <div class="nr-input-wrap">
      <textarea id="input" rows="1" placeholder="Ask about your code, or type @ to add a file"></textarea>
      <div class="nr-input-actions">
        <select id="modePicker" class="nr-mode" title="Mode">
          <option value="chat">Chat</option>
          <option value="analyze">Analyze project</option>
          <option value="terminal">Terminal</option>
          <option value="fix">Fix</option>
        </select>
        <button id="sendBtn" class="nr-send" title="Send">Send</button>
        <button id="stopBtn" class="nr-stop" title="Stop generating" hidden>Stop</button>
      </div>
    </div>
    <div class="nr-hint" id="hint"></div>
  </footer>

  <div id="popover" class="nr-popover" hidden></div>

  <script nonce="${n}" src="${asUri("highlight.js")}"></script>
  <script nonce="${n}" src="${asUri("markdown.js")}"></script>
  <script nonce="${n}" src="${asUri("main.js")}"></script>
</body>
</html>`;
  }

  dispose(): void {
    this._abort?.abort();
    this._disposables.forEach((d) => d.dispose());
  }

  // --- messaging -------------------------------------------------------

  private async _onMessage(raw: unknown): Promise<void> {
    const msg = raw as Incoming;
    if (!msg || typeof msg.type !== "string") {
      return;
    }
    try {
      switch (msg.type) {
        case "ready":
          this._ready = true;
          await this.pushState();
          await this.pushFullHistory();
          await this.pushStatus();
          break;
        case "requestState":
          await this.pushState();
          await this.pushFullHistory();
          break;
        case "send":
          // Fall back to queued mentions so a host-queued handoff survives a
          // webview that has not rendered its chips yet.
          const mentions = msg.mentions?.length ? msg.mentions : this._pendingMentions;
          await this.send(msg.text, msg.mode, mentions);
          break;
        case "stop":
          this._abort?.abort();
          break;
        case "regenerate":
          await this.regenerate();
          break;
        case "editMessage":
          await this.editMessage(msg.id, msg.text);
          break;
        case "deleteMessage":
          this.deleteMessage(msg.id);
          break;
        case "newChat":
          this._history.create();
          this._mode = "chat";
          await this.pushFullHistory();
          await this.post({ type: "setConfig", config: await this._viewConfig() });
          break;
        case "loadConversation":
          await this._loadConversation(msg.id);
          break;
        case "deleteConversation":
          this._history.delete(msg.id);
          await this.pushFullHistory();
          break;
        case "setMode":
          this._mode = msg.mode;
          await this.post({ type: "setConfig", config: await this._viewConfig() });
          break;
        case "setModel":
          await updateSetting("model", msg.id);
          await this.post({ type: "setConfig", config: await this._viewConfig() });
          await this.pushStatus();
          break;
        case "command":
          await this.runCommand(msg.id);
          break;
        case "runQuickAction":
          await this.runQuickAction(msg.action);
          break;
        case "openFile":
          await this.openFile(msg.path);
          break;
        case "codeAction":
          await this.codeAction(msg);
          break;
        case "mentionQuery":
          await this.mentionQuery(msg.query);
          break;
        case "feedback":
          logInfo(`feedback ${msg.value} for ${msg.messageId}`);
          break;
      }
    } catch (err) {
      logError(`handler for ${msg.type} failed`, err);
      await this.post({
        type: "showNotice",
        level: "error",
        message: `NightRider: ${(err as Error).message ?? "unexpected error"}`
      });
    }
  }

  private post(message: HostMessage): Thenable<boolean> {
    return this._view?.webview.postMessage(message) ?? Promise.resolve(false);
  }

  private async pushState(): Promise<void> {
    const hasKey = await this._secrets.has();
    await this.post({ type: "setConfig", config: await this._viewConfig() });
    if (!hasKey && this._ready) {
      await this.post({
        type: "showNotice",
        level: "warn",
        message: "No API key stored yet. Run “NightRider: Set API Key” to connect a model provider."
      });
    }
  }

  private async pushStatus(): Promise<void> {
    const status: ViewStatus = {
      provider: providerName(getConfig().apiBaseUrl),
      model: modelLabel(getConfig().model),
      copilotInstalled: this._copilot.state.installed,
      copilotSignedIn: this._copilot.state.signedIn,
      copilotLimited: this._copilot.state.limited,
      hasKey: await this._secrets.has()
    };
    await this.post({ type: "setStatus", status });
  }

  private async pushFullHistory(): Promise<void> {
    const active = this._history.active();
    await this.post({
      type: "render",
      conversation: active ? HistoryStore.sanitize(active) : null
    });
  }

  private async _viewConfig(): Promise<ViewConfig> {
    const cfg = getConfig();
    return {
      model: cfg.model,
      mode: this._mode,
      models: MODELS,
      streaming: cfg.streaming,
      autoContext: cfg.autoContext,
      includeCurrentFile: cfg.includeCurrentFile,
      workspaceTrusted: vscode.workspace.isTrusted,
      contextChars: cfg.maxFileContextChars
    };
  }

  // --- request pipeline -------------------------------------------------

  private async send(text: string, mode: Mode, mentions: string[]): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed || this._busy) {
      return;
    }

    const key = await this._secrets.get();
    if (!key) {
      await vscode.window.showErrorMessage("NightRider: no API key is set. Run “NightRider: Set API Key”.");
      await this.pushState();
      return;
    }

    const conversation = this._history.ensureActive();
    const user: ChatMessage = {
      id: newMessageId(),
      role: "user",
      content: trimmed,
      mode,
      createdAt: Date.now(),
      mentions: mentions.length ? [...mentions] : undefined
    };
    conversation.messages.push(user);
    this._history.save(conversation);
    await this.post({ type: "render", conversation: HistoryStore.sanitize(conversation) });

    await this._run(conversation, mode, [...conversation.messages], mentions);
  }

  private async regenerate(): Promise<void> {
    if (this._busy) {
      return;
    }
    const conversation = this._history.active();
    if (!conversation) {
      return;
    }
    const lastAssistant = [...conversation.messages].reverse().find((m) => m.role === "assistant");
    if (lastAssistant) {
      conversation.messages = conversation.messages.filter((m) => m.id !== lastAssistant.id);
    }
    const lastUser = [...conversation.messages].reverse().find((m) => m.role === "user");
    if (!lastUser) {
      return;
    }
    this._history.save(conversation);
    await this.post({ type: "render", conversation: HistoryStore.sanitize(conversation) });
    await this._run(conversation, lastUser.mode, [...conversation.messages], lastUser.mentions ?? []);
  }

  private async _run(
    conversation: Conversation,
    mode: Mode,
    history: ChatMessage[],
    mentions: string[]
  ): Promise<void> {
    const cfg = getConfig();
    const key = await this._secrets.get();
    if (!key) {
      return;
    }

    const assistant: ChatMessage = {
      id: newMessageId(),
      role: "assistant",
      content: "",
      mode,
      createdAt: Date.now(),
      pending: true,
      model: cfg.model
    };

    this._busy = true;
    this._abort = new AbortController();
    await this.post({ type: "busy", busy: true });
    await this.post({ type: "streamStart", message: assistant });

    let acc = "";
    let dirty = false;
    const flush = (): void => {
      if (!dirty) {
        return;
      }
      dirty = false;
      void this.post({ type: "streamDelta", messageId: assistant.id, text: acc });
    };
    const pending = setInterval(flush, 80);

    try {
      const context = await buildContext({
        mentions,
        query: history.findLast((m) => m.role === "user")?.content ?? "",
        includeSelection: cfg.includeSelection,
        config: cfg
      });

      const messages: ChatMessageIn[] = [
        { role: "system", content: systemPrompt(mode, context, cfg.systemPrompt) },
        ...toWire(history)
      ];

      const result = await complete({
        baseUrl: cfg.apiBaseUrl,
        apiKey: key,
        model: cfg.model,
        messages,
        temperature: cfg.temperature,
        maxTokens: cfg.maxOutputTokens,
        stream: cfg.streaming,
        signal: this._abort.signal,
        onDelta: (delta) => {
          acc += delta;
          dirty = true;
        }
      });

      clearInterval(pending);
      flush();
      assistant.content = result.text.trim();
      assistant.pending = false;
      assistant.model = result.model;
      conversation.messages.push(assistant);
      this._history.save(conversation);
      await this.post({ type: "streamEnd", message: assistant });
    } catch (err) {
      clearInterval(pending);
      const llmError = err instanceof LlmError ? err : new LlmError((err as Error).message, "unknown");

      if (llmError.kind === "aborted") {
        assistant.pending = false;
        if (acc.trim()) {
          assistant.content = acc.trim();
          conversation.messages.push(assistant);
          this._history.save(conversation);
          await this.post({ type: "streamEnd", message: assistant });
        } else {
          await this.post({ type: "streamCancelled", messageId: assistant.id });
        }
      } else {
        logWarn(`request failed: ${llmError.kind} ${llmError.message}`);
        await this.post({
          type: "error",
          messageId: assistant.id,
          text: llmError.message,
          kind: llmError.kind
        });
      }
    } finally {
      clearInterval(pending);
      this._busy = false;
      this._abort = undefined;
      await this.post({ type: "busy", busy: false });
      void this.pushStatus();
    }
  }

  private async editMessage(id: string, text: string): Promise<void> {
    const conversation = this._history.active();
    if (!conversation) {
      return;
    }
    const index = conversation.messages.findIndex((m) => m.id === id);
    if (index === -1) {
      return;
    }
    const target = conversation.messages[index];
    if (target.role !== "user") {
      return;
    }
    conversation.messages = conversation.messages.slice(0, index);
    target.content = text.trim();
    target.createdAt = Date.now();
    conversation.messages.push(target);
    this._history.save(conversation);
    await this.post({ type: "render", conversation: HistoryStore.sanitize(conversation) });
    await this._run(conversation, target.mode, [...conversation.messages], target.mentions ?? []);
  }

  private deleteMessage(id: string): void {
    const conversation = this._history.active();
    if (!conversation) {
      return;
    }
    conversation.messages = conversation.messages.filter((m) => m.id !== id);
    this._history.save(conversation);
    void this.post({ type: "render", conversation: HistoryStore.sanitize(conversation) });
  }

  private async _loadConversation(id: string): Promise<void> {
    const conversation = this._history.get(id);
    if (!conversation) {
      return;
    }
    await this._history.save(conversation);
    this._mode = conversation.messages.find((m) => m.role === "user")?.mode ?? "chat";
    await this.post({ type: "render", conversation: HistoryStore.sanitize(conversation) });
    await this.post({ type: "setConfig", config: await this._viewConfig() });
  }

  // --- actions ----------------------------------------------------------

  private async openFile(relPath: string): Promise<void> {
    const index = await getFileIndex();
    const match =
      index.all.find((f) => f.relPath === relPath) ??
      index.all.find((f) => f.relPath.toLowerCase().endsWith(relPath.toLowerCase()));
    const uri = match?.uri ?? vscode.Uri.file(relPath);
    try {
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), {
        preview: true
      });
    } catch (err) {
      void vscode.window.showErrorMessage(`NightRider: could not open ${relPath} (${(err as Error).message}).`);
    }
  }

  private async codeAction(msg: Extract<Incoming, { type: "codeAction" }>): Promise<void> {
    const code = stripFences(msg.code);
    switch (msg.action) {
      case "copy":
        await vscode.env.clipboard.writeText(code);
        void vscode.window.showInformationMessage("NightRider: code copied.");
        break;
      case "apply":
        await this._applier.replaceActiveFile(code, true);
        break;
      case "insert":
        await this._applier.insertAtCursor(code);
        break;
      case "preview":
        await this._applier.replaceActiveFile(code, true);
        break;
      case "run":
        await runInTerminal(code);
        break;
    }
  }

  /** Only extension-owned commands are reachable from the webview. */
  private async runCommand(id: string): Promise<void> {
    if (!id.startsWith("nightrider.")) {
      return;
    }
    const known = [
      "nightrider.copilot.switch",
      "nightrider.copilot.clearLimit",
      "nightrider.copilot.status",
      "nightrider.key.set",
      "nightrider.key.clear",
      "nightrider.model.select",
      "nightrider.chat.history",
      "nightrider.chat.newChat",
      "nightrider.config.open"
    ];
    if (!known.includes(id)) {
      logWarn(`rejected unknown webview command: ${id}`);
      return;
    }
    await vscode.commands.executeCommand(id);
  }

  private async mentionQuery(query: string): Promise<void> {    const index = await getFileIndex();
    const trimmed = query.trim();

    let results: { path: string; name: string }[];
    if (!trimmed) {
      results = index.all.slice(0, 25).map(toRef);
    } else {
      const lower = trimmed.toLowerCase();
      const starts = index.all.filter((f) => f.relPath.toLowerCase().includes(lower));
      if (starts.length >= 20) {
        results = starts.slice(0, 25).map(toRef);
      } else {
        const fuzzy = rankFiles(index, trimmed, 25);
        const seen = new Set(starts.map((f) => f.relPath));
        results = [...starts.map(toRef), ...fuzzy.filter((f) => !seen.has(f.relPath)).map(toRef)].slice(0, 25);
      }
    }

    await this.post({ type: "mentionResults", files: results });
  }
}

function toRef(f: { relPath: string; name: string }): { path: string; name: string } {
  return { path: f.relPath, name: f.name };
}

function createNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let text = "";
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}

/**
 * Long chats would otherwise grow without bound and eventually blow the
 * context window (or cost a fortune), so the tail of the conversation is kept
 * within a character budget. The most recent user turn is never dropped.
 */
const HISTORY_CHAR_BUDGET = 24_000;

/** Trims conversation history down to what the model actually needs. */
function toWire(history: ChatMessage[]): ChatMessageIn[] {
  const usable = history.filter((m) => m.content.trim() && !m.error);
  if (usable.length === 0) {
    return [];
  }

  const kept: ChatMessage[] = [];
  let used = 0;
  for (let i = usable.length - 1; i >= 0; i -= 1) {
    const message = usable[i];
    const cost = message.content.length;
    if (used + cost > HISTORY_CHAR_BUDGET && kept.length > 0) {
      break;
    }
    used += cost;
    kept.push(message);
  }
  kept.reverse();

  // Never start the transcript on an assistant turn.
  while (kept.length > 1 && kept[0].role === "assistant") {
    kept.shift();
  }

  return kept.map((m) => ({ role: m.role, content: m.content }));
}

export function stripFences(text: string): string {
  const trimmed = text.trim();
  const match = trimmed.match(/^```[a-zA-Z0-9+#._-]*\r?\n([\s\S]*?)\r?\n?```$/);
  return (match ? match[1] : trimmed).replace(/\s+$/, "");
}

export function providerName(baseUrl: string): string {
  try {
    const host = new URL(baseUrl).host;
    if (host.includes("groq")) {
      return "Groq";
    }
    if (host.includes("openai")) {
      return "OpenAI";
    }
    if (host.includes("openrouter")) {
      return "OpenRouter";
    }
    if (host.includes("together")) {
      return "Together";
    }
    if (host.includes("localhost") || host.includes("127.0.0.1")) {
      return "Local";
    }
    return host;
  } catch {
    return "provider";
  }
}
