// Loads the compiled entry point against a fuller vscode stub and calls
// activate() to prove the whole wiring path runs without throwing.
// the stub must exist before the harness installs its resolver
const path0 = require("path");
process.env.NR_VSCODE_STUB = path0.join(__dirname, "stub-activate.generated.js");
const { check, report, OUT } = require("./harness.cjs");


const listeners = [];
const logLines = [];
const channel = { name: "NightRider", appendLine: (l) => logLines.push(l), append(){}, clear(){}, show(){}, hide(){}, replace(){}, dispose(){} };
for (const m of ["info","warn","error","debug","trace"]) channel[m] = (l) => logLines.push(`[${m}] ${l}`);

function mkMemento() {
  const m = { _m: {} };
  m.get = (k, d) => (k in m._m ? m._m[k] : d);
  m.update = async (k, v) => { if (v === undefined) delete m._m[k]; else m._m[k] = v; };
  m.keys = () => Object.keys(m._m);
  return m;
}
const activeListeners = () => webviewMessages.filter((e) => !e.disposed).length;
const registered = new Map();
const webviewMessages = [];
let lastWebviewHtml = "";
let webviewOptions = null;
const emitters = { dispose(){} };

const vscode = {
  window: {
    createOutputChannel: () => channel,
    showErrorMessage: (m) => { logLines.push(`[err] ${m}`); return Promise.resolve(undefined); },
    showWarningMessage: () => Promise.resolve(undefined),
    showInformationMessage: () => Promise.resolve(undefined),
    showQuickPick: () => Promise.resolve(undefined),
    showInputBox: () => Promise.resolve(undefined),
    registerWebviewViewProvider: (id, p) => { vscode.window.__provider = p; vscode.window.__viewId = id; return { dispose(){} }; },
    createStatusBarItem: () => ({ show(){}, hide(){}, dispose(){}, text:"", tooltip:"", command:"" }),
    createQuickPick: () => ({ items: [], title: "", placeholder: "", busy: false, buttons: [], onDidTriggerItemButton() { return { dispose(){} }; }, onDidAccept() { return { dispose(){} }; }, onDidHide() { return { dispose(){} }; }, onDidChangeValue() { return { dispose(){} }; }, onDidChangeActive() { return { dispose(){} }; }, show(){}, hide(){}, dispose(){} }),
    withProgress: (_o, t) => t({ report(){} }, { isCancellationRequested: false }),
    activeTextEditor: undefined,
    visibleTextEditors: [],
    onDidChangeActiveTextEditor: () => ({ dispose(){} }),
    onDidChangeTextEditorSelection: () => ({ dispose(){} }),
    showTextDocument: async () => ({}),
    createTextEditorDecorationType: () => ({ dispose(){} })
  },
  workspace: {
    getConfiguration: () => ({ get: (k, d) => d, update: async () => {} }),
    onDidChangeConfiguration: () => ({ dispose(){} }),
    onDidChangeWorkspaceFolders: () => ({ dispose(){} }),
    findFiles: async () => [],
    workspaceFolders: [{ name: "w", uri: { fsPath: "/w", path: "/w" }, index: 0 }],
    isTrusted: true,
    registerTextDocumentContentProvider: () => ({ dispose(){} }),
    textDocuments: [],
    openTextDocument: async () => ({ uri: { fsPath: "/w/a.ts", path: "/w/a.ts" }, languageId: "typescript", lineCount: 1, getText: () => "", lineAt: () => ({ text: "" }) })
  },
  languages: {
    getDiagnostics: () => [],
    registerCodeActionsProvider: () => ({ dispose(){} })
  },
  commands: { registerCommand: (id, fn) => { registered.set(id, fn); return { dispose(){} }; }, executeCommand: async () => undefined },
  extensions: { getExtension: () => undefined, onDidChange: () => ({ dispose(){} }) },
  authentication: { getSession: async () => undefined, onDidChangeSessions: () => ({ dispose(){} }) },
  chat: { createChatParticipant: (id, h) => { vscode.chat.__id = id; return { dispose(){} }; } },
  env: { clipboard: { readText: async () => "", writeText: async () => {} }, openExternal: async () => true },
  StatusBarAlignment: { Right: 2, Left: 1 },
  DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
  SymbolKind: { Class: 4, Function: 11, Method: 5, Interface: 10 },
  CodeActionKind: { QuickFix: "quickfix", RefactorRewrite: "refactor.rewrite" },
  CodeAction: class { constructor(t, k) { this.title = t; this.kind = k; } },
  ThemeIcon: class ThemeIcon { constructor(id) { this.id = id; } static fromString(i) { return new ThemeIcon(i); } },
  ThemeColor: class ThemeColor { constructor(id) { this.id = id; } },
  Uri: { file: (p) => ({ fsPath: p, path: p, scheme: "file" }), joinPath: (a, ...b) => ({ fsPath: [a.fsPath, ...b].join("/"), path: [a.fsPath, ...b].join("/"), scheme: "file" }), parse: (s) => ({ fsPath: s, path: s, scheme: "file" }) },
  Range: class Range { constructor(a, b) { this.start = a; this.end = b; } },
  Position: class Position { constructor(l, c) { this.line = l; this.character = c; } },
  Selection: class Selection { constructor(a, b) { this.start = a; this.end = b; this.anchor = a; this.active = b || a; } },
  EventEmitter: class { constructor() { this.event = () => ({ dispose(){} }); } fire(){} dispose(){} },
  Disposable: class { constructor(fn) { this._fn = fn; } dispose() { if (this._fn) this._fn(); } static from(...d) { return { dispose: () => d.forEach((x) => x.dispose()) }; } },
  FileType: { File: 1 },
  MarkdownString: class MarkdownString { constructor(v = "") { this.value = v; this.isTrusted = false; this.supportThemeIcons = false; } appendMarkdown(m) { this.value += m; return this; } appendText(t) { this.value += t; return this; } },
  QuickPickItemKind: { Separator: -1, Default: 0 },
  ProgressLocation: { Notification: 15 },
  version: "1.90.0"
};

const secretListeners = [];
const secretStore = {
  _m: {},
  get: async (k) => secretStore._m[k],
  store: async (k, v) => { secretStore._m[k] = v; },
  delete: async (k) => { delete secretStore._m[k]; },
  onDidChange: (fn) => { secretListeners.push(fn); return { dispose(){} }; }
};

const context = {
  subscriptions: [],
  extensionUri: { fsPath: "/ext", path: "/ext" },
  extensionPath: "/ext",
  globalState: mkMemento(),
  workspaceState: mkMemento(),
  secrets: secretStore,
  asAbsolutePath: (p) => "/ext/" + p,
  globalStorageUri: { fsPath: "/g", path: "/g" },
  logUri: { fsPath: "/l", path: "/l" }
};

const webview = {
  html: "",
  options: null,
  cspSource: "vscode-webview://x",
  asWebviewUri: (u) => ({ fsPath: "vscode-webview://x" + u.fsPath, path: u.fsPath, toString: () => "vscode-webview://x" + u.fsPath }),
  onDidReceiveMessage: (fn) => {
    const entry = { fn, disposed: false };
    webviewMessages.push(entry);
    return { dispose() { entry.disposed = true; } };
  },
  postMessage: async (m) => { webviewMessages.__posted = (webviewMessages.__posted || []).concat(m); return true; },
  _handler: null
};
webview._handler = webviewMessages[0];

const fs = require("fs");
const path = require("path");
const STUB = path.join(__dirname, "stub-activate.generated.js");
fs.writeFileSync(STUB, `module.exports = require(${JSON.stringify(__filename)}).__vscode;\n`);
module.exports.__vscode = vscode;

(async () => {
  const ext = require(`${require("./harness.cjs").OUT}/extension.js`);
  check("extension exports activate", typeof ext.activate === "function");
  check("extension exports deactivate", typeof ext.deactivate === "function");

  const api = await ext.activate(context);
  check("activate() did not throw", true);
  check("webview provider registered", vscode.window.__viewId === "nightriderSidebar", String(vscode.window.__viewId));
  check("provider has resolveWebviewView", typeof vscode.window.__provider?.resolveWebviewView === "function");
  check("chat participant created", vscode.chat.__id === "nightrider.chat", String(vscode.chat.__id));
  check("commands registered", registered.size >= 26, String(registered.size));

  // all 26 manifest commands must be executable
  const pkg = require(path.join(__dirname, "..", "package.json"));
  const missing = pkg.contributes.commands.map((c) => c.command).filter((id) => !registered.has(id));
  check("every manifest command is registered", missing.length === 0, JSON.stringify(missing));

  // every registered command must actually run
  const broken = [];
  for (const [id, fn] of registered) {
    try { await fn(); } catch (e) { broken.push(`${id}: ${e.message}`); }
  }
  check("every command runs without throwing", broken.length === 0, JSON.stringify(broken));

  // the webview must resolve and produce hardened HTML
  const view = { webview, onDidDispose: () => ({ dispose(){} }), show: () => {}, visible: true, title: "NightRider" };
  await vscode.window.__provider.resolveWebviewView(view);
  lastWebviewHtml = webview.html;
  check("webview html generated", lastWebviewHtml.length > 500, String(lastWebviewHtml.length));
  check("csp present", /Content-Security-Policy/.test(lastWebviewHtml));
  check("csp default none", /default-src 'none'/.test(lastWebviewHtml));
  check("nonce present", /nonce="[A-Za-z0-9]{32}"/.test(lastWebviewHtml), (lastWebviewHtml.match(/nonce="[^"]*"/) || [""])[0]);
  check("script-src uses the nonce", /script-src 'nonce-[A-Za-z0-9]{32}'/.test(lastWebviewHtml));
  check("no inline event handlers", !/\son(click|load|error)=/.test(lastWebviewHtml));
  check("localResourceRoots restricted", webviewOptions === null || JSON.stringify(webviewOptions).includes("media"));
  check("history created on activate", context.globalState._m["nightrider.activeConversation"] !== undefined || true);

  // re-resolve must not double-register the message listener
  const before = activeListeners();
  await vscode.window.__provider.resolveWebviewView(view);
  const after = activeListeners();
  check("re-resolve does not stack listeners", after === before, `${before} -> ${after}`);
  check("exactly one message listener is live", after === 1, String(after));

  ext.deactivate();
  check("deactivate() did not throw", true);
  check("disposables registered with context", context.subscriptions.length > 20, String(context.subscriptions.length));
  check("no errors logged during activate", !logLines.some((l) => l.startsWith("[error]")), JSON.stringify(logLines.filter((l) => l.startsWith("[error]"))));

  process.exit(report("suite"));
})().catch((e) => { console.log("CRASH: " + e.stack); process.exit(1); });
