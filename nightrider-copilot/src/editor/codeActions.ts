import * as vscode from "vscode";
import { QUICK_ACTIONS } from "../llm/prompts";
import type { QuickActionId } from "../types";

/**
 * Surfaces the same actions in the lightbulb and the editor context menu that
 * the quick-action bar in the sidebar offers.
 */
export function registerCodeActions(
  run: (action: QuickActionId) => Promise<unknown>
): vscode.Disposable {
  const makeAction = (id: QuickActionId, scope: string): vscode.CodeAction => {
    const def = QUICK_ACTIONS[id];
    const action = new vscode.CodeAction(
      `NightRider: ${def.label} ${scope}`,
      vscode.CodeActionKind.RefactorRewrite
    );
    action.command = {
      command: "nightrider.action.runQuickAction",
      title: def.label,
      arguments: [id]
    };
    return action;
  };

  const provider: vscode.CodeActionProvider = {
    provideCodeActions(doc, range) {
      if (doc.getText().trim().length < 20) {
        return [];
      }

      if (!range.isEmpty) {
        const lines = `${range.start.line + 1}-${range.end.line + 1}`;
        return [
          makeAction("explain", `lines ${lines}`),
          makeAction("fix", `lines ${lines}`),
          makeAction("refactor", `lines ${lines}`)
        ];
      }

      const name = doc.uri.path.split("/").pop() ?? "this file";
      return [
        makeAction("explain", name),
        makeAction("fix", name),
        makeAction("document", name),
        makeAction("tests", name),
        makeAction("review", name),
        makeAction("refactor", name)
      ];
    }
  };

  return vscode.Disposable.from(
    vscode.languages.registerCodeActionsProvider({ scheme: "file" }, provider, {
      providedCodeActionKinds: [vscode.CodeActionKind.RefactorRewrite]
    }),
    vscode.commands.registerCommand("nightrider.action.runQuickAction", (id: QuickActionId) => run(id))
  );
}
