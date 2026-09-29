import * as vscode from "vscode";

export type Mode = "chat" | "analyze" | "terminal" | "fix";

export interface NightRiderConfig {
  apiBaseUrl: string;
  model: string;
  temperature: number;
  maxOutputTokens: number;
  streaming: boolean;
  systemPrompt: string;
  includeCurrentFile: boolean;
  includeSelection: boolean;
  maxContextFiles: number;
  maxFileContextChars: number;
  autoContext: boolean;
  confirmBeforeApply: boolean;
  confirmBeforeRun: boolean;
  saveHistory: boolean;
  maxSavedConversations: number;
  copilotStatusBar: boolean;
  copilotAutoHandoff: boolean;
  copilotHandoffContext: boolean;
  telemetryNotice: boolean;
}

const SECTION = "nightrider";

export function getConfig(): NightRiderConfig {
  const c = vscode.workspace.getConfiguration(SECTION);
  return {
    apiBaseUrl: c.get<string>("apiBaseUrl") ?? "https://api.groq.com/openai/v1",
    model: c.get<string>("model") ?? "openai/gpt-oss-120b",
    temperature: c.get<number>("temperature") ?? 0.2,
    maxOutputTokens: c.get<number>("maxOutputTokens") ?? 4096,
    streaming: c.get<boolean>("streaming") ?? true,
    systemPrompt: c.get<string>("systemPrompt") ?? "",
    includeCurrentFile: c.get<boolean>("includeCurrentFile") ?? true,
    includeSelection: c.get<boolean>("includeSelection") ?? true,
    maxContextFiles: c.get<number>("maxContextFiles") ?? 6,
    maxFileContextChars: c.get<number>("maxFileContextChars") ?? 24000,
    autoContext: c.get<boolean>("autoContext") ?? true,
    confirmBeforeApply: c.get<boolean>("confirmBeforeApply") ?? true,
    confirmBeforeRun: c.get<boolean>("confirmBeforeRun") ?? true,
    saveHistory: c.get<boolean>("saveHistory") ?? true,
    maxSavedConversations: c.get<number>("maxSavedConversations") ?? 25,
    copilotStatusBar: c.get<boolean>("copilot.statusBar") ?? true,
    copilotAutoHandoff: c.get<boolean>("copilot.autoHandoff") ?? true,
    copilotHandoffContext: c.get<boolean>("copilot.handoffContext") ?? true,
    telemetryNotice: c.get<boolean>("telemetryNotice") ?? true
  };
}

export async function updateSetting(key: string, value: unknown): Promise<void> {
  await vscode.workspace
    .getConfiguration(SECTION)
    .update(key, value, vscode.ConfigurationTarget.Workspace);
}

export function onConfigChange(handler: () => void): vscode.Disposable {
  return vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration(SECTION)) {
      handler();
    }
  });
}
