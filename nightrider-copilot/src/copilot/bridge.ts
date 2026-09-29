import * as vscode from "vscode";

export interface CopilotState {
  installed: boolean;
  chatInstalled: boolean;
  version?: string;
  signedIn: boolean;
  /** Set by the user, or by us when a Copilot limit error is reported. */
  limited: boolean;
}

const LIMITED_KEY = "knightrider.copilot.limited";

/**
 * GitHub does not expose Copilot's remaining premium-request quota to other
 * extensions, and reading it out of the Copilot extension's private storage is
 * both unsupported and brittle. So the parts we can observe honestly are
 * detected (is Copilot installed, is the user signed in) and the quota state is
 * driven by an explicit signal from the developer.
 */
export class CopilotBridge implements vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<CopilotState>();
  private readonly _subscriptions: vscode.Disposable[] = [];
  private _state: CopilotState = {
    installed: false,
    chatInstalled: false,
    signedIn: false,
    limited: false
  };

  readonly onDidChange = this._onDidChange.event;

  constructor(private readonly _global: vscode.Memento) {
    this._state.limited = this._global.get<boolean>(LIMITED_KEY, false);
    this._subscriptions.push(
      vscode.extensions.onDidChange(() => void this.refresh()),
      vscode.authentication.onDidChangeSessions((e) => {
        if (e.provider.id === "github") {
          void this.refresh();
        }
      })
    );
  }

  get state(): CopilotState {
    return this._state;
  }

  async refresh(): Promise<CopilotState> {
    const chat = vscode.extensions.getExtension("github.copilot-chat");
    const core = vscode.extensions.getExtension("github.copilot");
    let signedIn = false;
    try {
      const session = await vscode.authentication.getSession("github", [], {
        createIfNone: false
      });
      signedIn = !!session;
    } catch {
      signedIn = false;
    }

    this._state = {
      installed: !!(chat ?? core),
      chatInstalled: !!chat,
      version: (chat ?? core)?.packageJSON?.version,
      signedIn,
      limited: this._state.limited
    };
    this._onDidChange.fire(this._state);
    return this._state;
  }

  async reportLimit(): Promise<void> {
    await this._global.update(LIMITED_KEY, true);
    this._state = { ...this._state, limited: true };
    this._onDidChange.fire(this._state);
  }

  async clearLimit(): Promise<void> {
    await this._global.update(LIMITED_KEY, false);
    this._state = { ...this._state, limited: false };
    this._onDidChange.fire(this._state);
  }

  async statusSummary(): Promise<string> {
    const s = await this.refresh();
    const lines = ["Copilot", ""];
    lines.push(`  Chat extension : ${s.chatInstalled ? "installed" : s.installed ? "core only" : "not detected"}`);
    if (s.version) {
      lines.push(`  Version        : ${s.version}`);
    }
    lines.push(`  GitHub sign-in : ${s.signedIn ? "yes" : "no"}`);
    lines.push(`  Quota state    : ${s.limited ? "reported as exhausted" : "unknown (GitHub does not expose this)"}`);
    return lines.join("\n");
  }

  dispose(): void {
    this._subscriptions.forEach((d) => d.dispose());
    this._onDidChange.dispose();
  }
}
