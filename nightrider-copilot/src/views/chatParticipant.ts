import * as vscode from "vscode";
import { getConfig } from "../config";
import { buildContext } from "../context/engine";
import { LlmError, complete, toAbortSignal, type ChatMessageIn } from "../llm/client";
import { QUICK_ACTIONS, systemPrompt } from "../llm/prompts";
import { logInfo, logWarn } from "../logging";
import type { SecretStore } from "../secrets";
import type { HistoryStore } from "../history";
import type { ChatViewProvider } from "./chatView";
import { stripFences } from "./chatView";

/**
 * Registers `@knightrider` inside the native VS Code chat view so the assistant
 * is usable from the same surface as Copilot Chat.
 */
export function registerChatParticipant(
  chat: ChatViewProvider,
  history: HistoryStore,
  secrets: SecretStore
): vscode.Disposable {
  let participant: vscode.ChatParticipant | undefined;

  try {
    participant = vscode.chat.createChatParticipant("knightrider.chat", async (
      request,
      context,
      stream,
      token
    ) => {
      const command = request.command;
      const basePrompt = command ? QUICK_ACTIONS[command as keyof typeof QUICK_ACTIONS]?.prompt : undefined;
      const userText = basePrompt
        ? `${basePrompt}\n\n${request.prompt}`.trim()
        : request.prompt;

      if (!(await secrets.has())) {
        stream.markdown(
          "**No API key is set.** Run *KnightRider: Set API Key* from the command palette, then try again."
        );
        return {};
      }

      const mentions = request.references
        .map((ref) => ref.value?.toString() ?? "")
        .filter((v) => !!v && !v.startsWith("vscode-"));

      const cfg = getConfig();
      const contextBundle = await buildContext({
        mentions,
        query: userText,
        includeSelection: cfg.includeSelection,
        config: cfg
      });

      const historyTurns: ChatMessageIn[] = [];
      for (const turn of context.history) {
        if (turn instanceof vscode.ChatRequestTurn) {
          historyTurns.push({ role: "user", content: turn.prompt });
        } else if (turn instanceof vscode.ChatResponseTurn) {
          const text = turn.response
            .filter((part): part is vscode.ChatResponseMarkdownPart => part instanceof vscode.ChatResponseMarkdownPart)
            .map((part) => part.value.value)
            .join("\n")
            .trim();
          if (text) {
            historyTurns.push({ role: "assistant", content: text });
          }
        }
      }

      const messages: ChatMessageIn[] = [
        { role: "system", content: systemPrompt("chat", contextBundle, cfg.systemPrompt) },
        ...historyTurns,
        { role: "user", content: userText }
      ];

      const key = await secrets.get();
      if (!key) {
        return {};
      }

      const abort = toAbortSignal(token);

      try {
        const result = await complete({
          baseUrl: cfg.apiBaseUrl,
          apiKey: key,
          model: cfg.model,
          messages,
          temperature: cfg.temperature,
          maxTokens: cfg.maxOutputTokens,
          stream: cfg.streaming,
          signal: abort.signal,
          onDelta: (delta) => {
            stream.markdown(delta);
          }
        });

        const code = extractCode(result.text);
        if (code) {
          stream.button({
            command: "knightrider.code.applyToFile",
            title: "$(check) Apply to file",
            arguments: [code]
          });
          stream.button({
            command: "knightrider.code.insertAtCursor",
            title: "$(insert) Insert at cursor",
            arguments: [code]
          });
        }

        const command_ = result.text.match(/```(?:ba)?sh\n([\s\S]*?)```/);
        if (command_) {
          stream.button({
            command: "knightrider.terminal.run",
            title: "$(terminal) Run in terminal",
            arguments: [command_[1].trim()]
          });
        }

        logInfo(`chat participant answered with ${result.completionTokens ?? "?"} tokens`);

        // Mirror the turn into the sidebar so the two surfaces share a history.
        const conversation = history.ensureActive();
        conversation.messages.push(
          { id: `cp-u-${Date.now().toString(36)}`, role: "user", content: userText, mode: "chat", createdAt: Date.now() },
          {
            id: `cp-a-${Date.now().toString(36)}`,
            role: "assistant",
            content: result.text,
            mode: "chat",
            createdAt: Date.now(),
            model: result.model
          }
        );
        history.save(conversation);

        return { metadata: { model: result.model, command } };
      } catch (err) {
        const error = err instanceof LlmError ? err : new LlmError((err as Error).message, "unknown");
        logWarn(`chat participant failed: ${error.kind}`);
        stream.markdown(`**KnightRider could not finish that.** ${error.message}`);
        return { metadata: { error: error.kind } };
      } finally {
        abort.dispose();
        void chat.refreshState();
      }
    });
  } catch (err) {
    // Older VS Code builds without the chat API should not break activation.
    logWarn("chat participant unavailable", err);
    return new vscode.Disposable(() => undefined);
  }

  participant.iconPath = vscode.Uri.joinPath(chat.extensionUri, "media", "knightrider.svg");

  return participant;
}

function extractCode(text: string): string | undefined {
  const blocks = [...text.matchAll(/```([a-zA-Z0-9+#._-]*)\r?\n([\s\S]*?)```/g)];
  for (const block of blocks) {
    const lang = (block[1] ?? "").toLowerCase();
    const isShell = ["bash", "sh", "shell", "console", "zsh", "powershell"].includes(lang);
    if (!isShell && block[2].trim()) {
      return stripFences(`\`\`\`${lang}\n${block[2]}\n\`\`\``);
    }
  }
  return undefined;
}
