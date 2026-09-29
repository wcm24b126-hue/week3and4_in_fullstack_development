import * as vscode from "vscode";

const KEY_ID = "nightrider.apiKey";

/**
 * Thin wrapper over `context.secrets` so the rest of the extension never has
 * to know how the key is stored. Keys live in the OS keychain, never in
 * settings or webview state.
 */
export class SecretStore implements vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<boolean>();

  readonly onDidChangeKey: vscode.Event<boolean> = this._onDidChange.event;

  private readonly _subscriptions: vscode.Disposable[] = [];

  constructor(private readonly _secrets: vscode.SecretStorage) {
    this._subscriptions.push(
      this._secrets.onDidChange((e) => {
        if (e.key === KEY_ID) {
          this._onDidChange.fire(true);
        }
      })
    );
  }

  async get(): Promise<string | undefined> {
    const value = await this._secrets.get(KEY_ID);
    return value?.trim() || undefined;
  }

  async set(value: string): Promise<void> {
    const trimmed = value.trim();
    if (!trimmed) {
      await this.clear();
      return;
    }
    await this._secrets.store(KEY_ID, trimmed);
  }

  async clear(): Promise<void> {
    await this._secrets.delete(KEY_ID);
  }

  async has(): Promise<boolean> {
    return !!(await this.get());
  }

  dispose(): void {
    this._subscriptions.forEach((d) => d.dispose());
    this._onDidChange.dispose();
  }
}
