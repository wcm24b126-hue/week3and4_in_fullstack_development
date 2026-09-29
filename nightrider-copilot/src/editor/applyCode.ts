import * as vscode from "vscode";
import { getConfig } from "../config";
import { logInfo, logWarn } from "../logging";

/** Serves the proposed file content so `vscode.diff` can render a preview. */
class PreviewProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri>();
  private readonly _contents = new Map<string, string>();
  private readonly _disposables: vscode.Disposable[] = [];

  readonly onDidChange = this._onDidChange.event;

  constructor() {
    this._disposables.push(
      vscode.workspace.registerTextDocumentContentProvider(PREVIEW_SCHEME, this)
    );
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this._contents.get(uri.toString()) ?? "";
  }

  set(uri: vscode.Uri, text: string): void {
    this._contents.set(uri.toString(), text);
    this._onDidChange.fire(uri);
  }

  clear(uri: vscode.Uri): void {
    this._contents.delete(uri.toString());
  }

  dispose(): void {
    this._disposables.forEach((d) => d.dispose());
    this._onDidChange.dispose();
    this._contents.clear();
  }
}

const PREVIEW_SCHEME = "nightrider-preview";

export class CodeApplier implements vscode.Disposable {
  private readonly _preview = new PreviewProvider();

  /**
   * Replaces the whole document, or the selection when the answer was scoped to
   * one and the selection is still intact.
   */
  async replaceActiveFile(code: string, preferSelection = true): Promise<boolean> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      void vscode.window.showErrorMessage("NightRider: open a file first so the code has somewhere to go.");
      return false;
    }
    if (!vscode.workspace.isTrusted) {
      void vscode.window.showErrorMessage("NightRider: trust this workspace to let the extension edit your files.");
      return false;
    }

    const doc = editor.document;
    const range = pickRange(doc, preferSelection);
    const current = range ? doc.getText(range) : doc.getText();

    const choice = await confirm(
      range
        ? `Replace ${range.isEmpty ? "the whole file" : "the selection"} in ${basename(doc)}?`
        : `Replace the whole file ${basename(doc)}?`,
      ["Replace", "Preview first", "Cancel"]
    );
    if (choice !== "Replace" && choice !== "Preview first") {
      return false;
    }

    if (choice === "Preview first") {
      return this.preview(doc, current, code);
    }

    return this.write(editor, range ?? fullRange(doc), code);
  }

  async insertAtCursor(code: string): Promise<boolean> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      void vscode.window.showErrorMessage("NightRider: open a file and place the cursor where the code should go.");
      return false;
    }
    if (!vscode.workspace.isTrusted) {
      void vscode.window.showErrorMessage("NightRider: trust this workspace to let the extension edit your files.");
      return false;
    }
    if (!(await confirm(`Insert this code into ${basename(editor.document)}?`, ["Insert", "Cancel"]))) {
      return false;
    }
    // Insert must never destroy a selection: use the caret as an empty range.
    const caret = new vscode.Position(editor.selection.active.line, editor.selection.active.character);
    return this.write(editor, new vscode.Range(caret, caret), "\n" + code + "\n");
  }

  /** Shows a side-by-side diff and can apply it from there. */
  async preview(doc: vscode.TextDocument, current: string, proposed: string): Promise<boolean> {
    if (current === proposed) {
      void vscode.window.showInformationMessage("NightRider: the proposal is identical to what is already there.");
      return false;
    }

    const uri = vscode.Uri.from({
      scheme: PREVIEW_SCHEME,
      path: doc.uri.path + ".nightrider-preview",
      query: Date.now().toString()
    });
    this._preview.set(uri, proposed);

    await vscode.commands.executeCommand("vscode.diff", doc.uri, uri, `${basename(doc)} (NightRider proposed)`, {
      preview: true
    });

    const choice = await vscode.window.showInformationMessage(
      "NightRider: apply these changes?",
      { modal: false },
      "Apply",
      "Discard"
    );
    this._preview.clear(uri);

    if (choice !== "Apply") {
      return false;
    }

    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.toString() !== doc.uri.toString()) {
      await vscode.window.showTextDocument(doc, { preview: false });
      return false;
    }
    const range = pickRange(editor.document, true) ?? fullRange(editor.document);
    return this.write(editor, range, proposed);
  }

  private async write(
    editor: vscode.TextEditor,
    range: vscode.Range,
    code: string
  ): Promise<boolean> {
    try {
      const applied = await editor.edit((builder) => {
        if (range.isEmpty) {
          builder.insert(range.start, code);
        } else {
          builder.replace(range, code);
        }
      });
      if (!applied) {
        void vscode.window.showErrorMessage("NightRider: could not apply the change (the file may have changed).");
        return false;
      }
      logInfo(`applied edit to ${editor.document.uri.fsPath}`);
      void vscode.window.showInformationMessage("NightRider: change applied.");
      return true;
    } catch (err) {
      logWarn("failed to apply edit", err);
      void vscode.window.showErrorMessage(`NightRider: ${(err as Error).message}`);
      return false;
    }
  }

  dispose(): void {
    this._preview.dispose();
  }
}

async function confirm(
  message: string,
  actions: string[]
): Promise<string | undefined> {
  if (!getConfig().confirmBeforeApply) {
    return actions[0];
  }
  return vscode.window.showWarningMessage(
    `NightRider: ${message}`,
    { modal: true },
    ...actions
  );
}

function pickRange(doc: vscode.TextDocument, preferSelection: boolean): vscode.Range | undefined {
  if (preferSelection) {
    const sel = vscode.window.activeTextEditor?.selection;
    if (sel && !sel.isEmpty && doc.uri.toString() === vscode.window.activeTextEditor?.document.uri.toString()) {
      return new vscode.Range(sel.start, sel.end);
    }
  }
  return undefined;
}

function fullRange(doc: vscode.TextDocument): vscode.Range {
  return new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
}

function basename(doc: vscode.TextDocument): string {
  return doc.uri.path.split("/").pop() || "the file";
}

export async function runInTerminal(command: string): Promise<boolean> {
  if (!vscode.workspace.isTrusted) {
    void vscode.window.showErrorMessage(
      "NightRider: trust this workspace before letting the extension run terminal commands."
    );
    return false;
  }

  const confirmChoice = getConfig().confirmBeforeRun
    ? await vscode.window.showWarningMessage(
        "NightRider: run this command?",
        { modal: true },
        "Run",
        "Copy instead",
        "Cancel"
      )
    : "Run";

  if (confirmChoice === "Copy instead") {
    await vscode.env.clipboard.writeText(command);
    void vscode.window.showInformationMessage("NightRider: command copied to the clipboard.");
    return false;
  }
  if (confirmChoice !== "Run") {
    return false;
  }

  const terminal = vscode.window.createTerminal("NightRider");
  terminal.show();
  terminal.sendText(command, true);
  return true;
}
