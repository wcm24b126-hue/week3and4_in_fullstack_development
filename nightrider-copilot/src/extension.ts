import * as vscode from "vscode";
import { getConfig, onConfigChange, updateSetting } from "./config";
import { invalidateFileIndex } from "./context/fileIndex";
import { CopilotBridge } from "./copilot/bridge";
import { CodeApplier, runInTerminal } from "./editor/applyCode";
import { registerCodeActions } from "./editor/codeActions";
import { HistoryStore, messageCounts } from "./history";
import { MODELS } from "./llm/models";
import { HANDOFF_PROMPT } from "./llm/prompts";
import { initLogging, logInfo } from "./logging";
import { SecretStore } from "./secrets";
import { ChatViewProvider, providerName } from "./views/chatView";
import { registerChatParticipant } from "./views/chatParticipant";
import { registerStatusBar } from "./views/statusBar";

interface HistoryPick extends vscode.QuickPickItem {
  id: string;
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const disposables: vscode.Disposable[] = [initLogging()];

  const secrets = new SecretStore(context.secrets);
  const history = new HistoryStore(context.globalState);
  const applier = new CodeApplier();
  const copilot = new CopilotBridge(context.globalState);
  await copilot.refresh();

  const chat = new ChatViewProvider(context, secrets, history, applier, copilot);

  disposables.push(
    secrets,
    history,
    applier,
    copilot,
    chat,
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, chat, {
      webviewOptions: { retainContextWhenHidden: true }
    })
  );

  const cmd = (id: string, fn: (...args: any[]) => unknown): vscode.Disposable =>
    vscode.commands.registerCommand(id, fn);

  disposables.push(
    cmd("knightrider.chat.focus", () => chat.focus()),
    cmd("knightrider.chat.ask", () => chat.focus()),

    cmd("knightrider.chat.newChat", async () => {
      history.create();
      await chat.focus();
    }),

    cmd("knightrider.chat.askAboutSelection", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        void vscode.window.showInformationMessage("KnightRider: open a file first.");
        return;
      }
      if (editor.selection.isEmpty) {
        void vscode.window.showInformationMessage(
          "KnightRider: select some code first - the selection is attached automatically."
        );
        await chat.focus();
        return;
      }
      // The selection stays in the editor; the context engine picks it up.
      await chat.focus();
      await chat.prompt("");
    }),

    cmd("knightrider.chat.editLastMessage", async () => {
      const conversation = history.active();
      const last = conversation
        ? [...conversation.messages].reverse().find((m) => m.role === "user")
        : undefined;
      if (!conversation || !last) {
        void vscode.window.showInformationMessage("KnightRider: there is no message to edit yet.");
        return;
      }
      const next = await vscode.window.showInputBox({
        title: "KnightRider: edit and resend",
        value: last.content,
        valueSelection: [0, last.content.length]
      });
      if (next === undefined) {
        return;
      }
      conversation.messages = conversation.messages.slice(
        0,
        conversation.messages.findIndex((m) => m.id === last.id)
      );
      history.save(conversation);
      await chat.prompt(next, { send: true, mode: last.mode, mentions: last.mentions ?? [] });
    }),

    cmd("knightrider.chat.history", async () => {
      await pickConversation(history, chat);
    }),

    cmd("knightrider.key.set", async () => {
      const value = await vscode.window.showInputBox({
        title: "KnightRider: API key",
        prompt: "Stored in your OS keychain, never in settings or files.",
        password: true,
        ignoreFocusOut: true,
        placeHolder: providerName(getConfig().apiBaseUrl) === "Groq" ? "gsk_..." : "sk-..."
      });
      if (value === undefined) {
        return;
      }
      await secrets.set(value);
      if (value.trim()) {
        void vscode.window.showInformationMessage("KnightRider: API key saved to the keychain.");
      }
    }),

    cmd("knightrider.key.clear", async () => {
      await secrets.clear();
      void vscode.window.showInformationMessage("KnightRider: API key removed.");
    }),

    cmd("knightrider.model.select", async () => {
      const current = getConfig().model;
      const picks: HistoryPick[] = MODELS.map((m) => ({
        id: m.id,
        label: m.id === current ? `$(check) ${m.label}` : m.label,
        description: m.id === current ? `${m.hint} - active` : m.hint,
        detail: m.id
      }));
      if (!picks.some((p) => p.id === current)) {
        picks.unshift({
          id: current,
          label: `$(check) ${current}`,
          description: "custom model - active",
          detail: current
        });
      }

      const choice = await vscode.window.showQuickPick(picks, {
        title: "KnightRider: select a model",
        placeHolder: "Any other model id can be set in knightrider.model",
        matchOnDescription: true,
        matchOnDetail: true
      });
      if (choice) {
        await updateSetting("model", choice.id);
        void vscode.window.showInformationMessage(`KnightRider: model set to ${choice.id}`);
      }
    }),

    cmd("knightrider.action.explain", () => chat.runQuickAction("explain")),
    cmd("knightrider.action.fix", () => chat.runQuickAction("fix")),
    cmd("knightrider.action.tests", () => chat.runQuickAction("tests")),
    cmd("knightrider.action.document", () => chat.runQuickAction("document")),
    cmd("knightrider.action.refactor", () => chat.runQuickAction("refactor")),
    cmd("knightrider.action.review", () => chat.runQuickAction("review")),

    cmd("knightrider.diagnostics.fixAll", async () => {
      const count = vscode.languages
        .getDiagnostics()
        .reduce((total, [, diags]) => total + diags.length, 0);
      if (count === 0) {
        void vscode.window.showInformationMessage("KnightRider: the workspace has no reported problems.");
        return;
      }
      await chat.prompt(
        `The language server reports ${count} problems in this workspace. Fix them, most severe first, ` +
          `using the problem locations in the context. Give the corrected code in a single fenced block.`,
        { send: true, mode: "fix" }
      );
    }),

    cmd("knightrider.code.copy", async (code?: string) => {
      if (typeof code === "string") {
        await vscode.env.clipboard.writeText(code);
        void vscode.window.showInformationMessage("KnightRider: code copied.");
      }
    }),
    cmd("knightrider.code.applyToFile", async (code?: string) => {
      if (typeof code === "string") {
        await applier.replaceActiveFile(code, true);
      }
    }),
    cmd("knightrider.code.insertAtCursor", async (code?: string) => {
      if (typeof code === "string") {
        await applier.insertAtCursor(code);
      }
    }),
    cmd("knightrider.code.preview", async (code?: string) => {
      if (typeof code === "string") {
        await applier.replaceActiveFile(code, true);
      }
    }),
    cmd("knightrider.terminal.run", async (command?: string) => {
      if (typeof command === "string") {
        await runInTerminal(command);
      }
    }),

    cmd("knightrider.copilot.reportLimit", async () => {
      await copilot.reportLimit();
      if (getConfig().copilotAutoHandoff) {
        await handoff();
      } else {
        void vscode.window.showWarningMessage(
          "KnightRider: Copilot marked as out of tokens. Use “Switch from Copilot to KnightRider” when you are ready."
        );
      }
    }),

    cmd("knightrider.copilot.clearLimit", async () => {
      await copilot.clearLimit();
      void vscode.window.showInformationMessage("KnightRider: Copilot quota state cleared.");
    }),

    cmd("knightrider.copilot.switch", async () => {
      await copilot.reportLimit();
      await handoff();
    }),

    cmd("knightrider.copilot.status", async () => {
      const summary = await copilot.statusSummary();
      const pick = await vscode.window.showQuickPick(
        [
          { label: "$(arrow-swap) Switch from Copilot to KnightRider", action: "switch" as const },
          { label: "$(refresh) Copilot tokens refreshed", action: "clear" as const },
          { label: "$(settings-gear) Open KnightRider settings", action: "settings" as const }
        ],
        { title: "KnightRider status", placeHolder: summary.replace(/\n/g, "   ") }
      );
      if (pick?.action === "switch") {
        await copilot.reportLimit();
        await handoff();
      } else if (pick?.action === "clear") {
        await copilot.clearLimit();
      } else if (pick?.action === "settings") {
        await vscode.commands.executeCommand("workbench.action.openSettings", "knightrider");
      }
    }),

    cmd("knightrider.config.open", () =>
      vscode.commands.executeCommand("workbench.action.openSettings", "knightrider")
    )
  );

  disposables.push(
    registerCodeActions((action) => chat.runQuickAction(action)),
    registerChatParticipant(chat, history, secrets),
    registerStatusBar(copilot),
    onConfigChange(() => {
      invalidateFileIndex();
      void chat.refreshState();
    })
  );

  /**
   * Carries a Copilot session across: the active selection and the clipboard
   * become attached context and the composer opens with a handoff prompt.
   */
  async function handoff(): Promise<void> {
    const mentions: string[] = [];
    const extras: string[] = [];

    if (getConfig().copilotHandoffContext) {
      const editor = vscode.window.activeTextEditor;
      if (editor && !editor.selection.isEmpty) {
        const selected = editor.document.getText(editor.selection);
        if (selected.trim()) {
          extras.push(
            `This is the code I was working on in Copilot:\n\`\`\`\n${selected}\n\`\`\``
          );
        }
      }

      let trimmed = "";
      try {
        trimmed = (await vscode.env.clipboard.readText()).trim();
      } catch {
        trimmed = "";
      }
      if (trimmed && trimmed.length < 20000 && !extras.some((e) => e.includes(trimmed.slice(0, 60)))) {
        extras.push(`This is what I had copied out of the Copilot chat:\n\`\`\`\n${trimmed}\n\`\`\``);
      }
    }

    const editor = vscode.window.activeTextEditor;
    if (editor) {
      const rel = vscode.workspace.asRelativePath(editor.document.uri, false);
      if (rel && !rel.startsWith("Untitled") && editor.document.uri.scheme !== "output") {
        mentions.push(rel);
      }
    }

    const prompt = extras.length ? `${HANDOFF_PROMPT}\n\n${extras.join("\n\n")}` : HANDOFF_PROMPT;

    await copilot.clearLimit();
    await chat.prompt(prompt, { send: false, mode: "chat", mentions });
    void vscode.window.showInformationMessage(
      "KnightRider: picked up where Copilot left off. Check the prompt, then press Send."
    );
  }

  if (getConfig().telemetryNotice) {
    void vscode.window
      .showInformationMessage(
        "KnightRider sends your prompts and the attached code to the model provider you configure. Nothing leaves your machine except that request.",
        "Got it"
      )
      .then((choice) => {
        if (choice === "Got it") {
          void updateSetting("telemetryNotice", false);
        }
      });
  }

  logInfo("KnightRider activated");

  // Hand ownership to VS Code. Without this nothing would be disposed on
  // deactivate: command registrations, the status bar, the chat participant
  // and the webview message listener would all stay live.
  context.subscriptions.push(...disposables);
}

export function deactivate(): void {
  // Every disposable registered above is handed to the ExtensionContext, which
  // VS Code disposes for us when the extension deactivates or the host exits.
  logInfo("KnightRider deactivated");
}

async function pickConversation(history: HistoryStore, chat: ChatViewProvider): Promise<void> {
  const toItem = (c: { id: string; messages: unknown[]; updatedAt: number }): HistoryPick => {
    const conversation = history.get(c.id);
    const count = conversation?.messages.length ?? 0;
    return {
      id: c.id,
      label: conversation ? messageCounts(conversation).first : "(missing)",
      description: `${count} message${count === 1 ? "" : "s"}`,
      detail: new Date(c.updatedAt).toLocaleString()
    };
  };

  const build = (): HistoryPick[] => history.list().map(toItem);

  const qp = vscode.window.createQuickPick<HistoryPick>();
  qp.items = build();
  qp.placeholder = "Restore a conversation, or use the trash button to delete one";
  qp.matchOnDescription = true;
  qp.matchOnDetail = true;
  qp.show();

  qp.onDidChangeValue((value) => {
    const v = value.toLowerCase();
    const all = build();
    qp.items = v
      ? all.filter((i) => `${i.label} ${i.description} ${i.detail}`.toLowerCase().includes(v))
      : all;
  });

  qp.onDidAccept(() => {
    const picked = qp.selectedItems[0];
    qp.hide();
    if (picked) {
      void chat.loadConversation(picked.id);
    }
  });

  qp.onDidTriggerItemButton((event) => {
    history.delete(event.item.id);
    qp.items = build();
  });

  qp.onDidHide(() => qp.dispose());
}
