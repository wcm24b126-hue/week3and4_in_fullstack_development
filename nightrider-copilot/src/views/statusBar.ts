import * as vscode from "vscode";
import { getConfig } from "../config";
import type { CopilotBridge } from "../copilot/bridge";
import { modelLabel } from "../llm/models";

export function registerStatusBar(copilot: CopilotBridge): vscode.Disposable {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  item.command = "nightrider.copilot.status";
  item.name = "NightRider AI";

  const render = (): void => {
    if (!getConfig().copilotStatusBar) {
      item.hide();
      return;
    }

    const limited = copilot.state.limited;

    item.text = limited
      ? "$(debug-pause) NightRider"
      : `$(hubot) NightRider: ${modelLabel(getConfig().model)}`;
    item.tooltip = new vscode.MarkdownString(
      [
        "**NightRider AI**",
        "",
        `- Model: \`${getConfig().model}\``,
        `- Provider: ${provider(getConfig().apiBaseUrl)}`,
        `- Streaming: ${getConfig().streaming ? "on" : "off"}`,
        "",
        copilot.state.installed
          ? `- GitHub Copilot: ${copilot.state.chatInstalled ? "detected" : "core only"}${copilot.state.signedIn ? ", signed in" : ""}`
          : "- GitHub Copilot: not detected",
        limited ? "- Copilot quota: **reported as exhausted**" : "",
        "",
        limited
          ? "Run *NightRider: Switch from Copilot* to carry your work over."
          : "Click for status, model switching and settings."
      ]
        .filter(Boolean)
        .join("\n")
    );
    item.backgroundColor = limited
      ? new vscode.ThemeColor("statusBarItem.warningBackground")
      : undefined;
    item.show();
  };

  render();

  const subs: vscode.Disposable[] = [
    copilot.onDidChange(render),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("nightrider")) {
        render();
      }
    })
  ];

  return vscode.Disposable.from(item, ...subs);
}

function provider(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}
