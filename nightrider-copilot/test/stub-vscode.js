const noop = () => {};
const __cfgValues = {};
const disposable = { dispose: noop };
const channel = { info: noop, warn: noop, error: noop, debug: noop, trace: noop, append: noop, appendLine: noop, clear: noop, show: noop, hide: noop, replace: noop, name: "x" };

// ---- instrumentation hooks (see __fs / __diag at the bottom) -------------
// The context engine reads files through workspace.fs rather than
// openTextDocument, and must only ever ask for the active document's
// diagnostics. Both are recorded so the regression suite can assert it.
const __fs = { statCalls: [], readCalls: [], files: new Map() };
const __diag = { calls: [], all: [] };
const __find = { calls: 0, results: [] };

const workspace = {
  getConfiguration: () => ({ get: (k, d) => (k in __cfgValues ? __cfgValues[k] : d) }),
  onDidChangeConfiguration: () => disposable,
  onDidChangeWorkspaceFolders: () => disposable,
  findFiles: async () => {
    __find.calls += 1;
    return __find.results;
  },
  isTrusted: true,
  workspaceFolders: [],
  asRelativePath: (p) => (p && p.fsPath ? p.fsPath : String(p)),
  getWorkspaceFolder: () => undefined,
  // openTextDocument must NOT be reachable from the context path. It stays a
  // throwing trap so a regression back to it fails loudly.
  openTextDocument: async () => {
    throw new Error("openTextDocument must not be used for file context");
  },
  fs: {
    stat: async (uri) => {
      __fs.statCalls.push(uri && uri.fsPath);
      const rec = __fs.files.get(uri && uri.fsPath);
      if (!rec) {
        const err = new Error("ENOENT");
        throw err;
      }
      return { type: 1, size: rec.length, ctime: 0, mtime: 0 };
    },
    readFile: async (uri) => {
      __fs.readCalls.push(uri && uri.fsPath);
      const rec = __fs.files.get(uri && uri.fsPath);
      if (!rec) {
        throw new Error("ENOENT");
      }
      return Buffer.from(rec);
    }
  }
};

module.exports = {
  window: {
    createOutputChannel: () => channel,
    showErrorMessage: noop,
    showInformationMessage: noop,
    showWarningMessage: noop,
    registerWebviewViewProvider: () => disposable,
    activeTextEditor: undefined
  },
  workspace,
  Uri: { file: (p) => ({ fsPath: p, path: p, scheme: "file" }), joinPath: (a, ...b) => ({ fsPath: [a.fsPath, ...b].join("/") }), from: (o) => o },
  EventEmitter: class { constructor(){ this.event = noop; } fire(){} dispose(){} },
  extensions: { onDidChange: () => disposable, getExtension: () => undefined },
  authentication: { getSession: async () => undefined, onDidChangeSessions: () => disposable },
  Range: class {}, Position: class {}, Selection: class {}, CodeAction: class {}, CodeActionKind: { RefactorRewrite: {} },
  DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
  SymbolKind: { Class: 4, Function: 11, Method: 5, Interface: 10, TypeParameter: 25 },
  ThemeColor: class {}, StatusBarAlignment: { Right: 2 }, FileType: { File: 1 },
  env: { clipboard: { readText: async () => "", writeText: async () => {} } },
  languages: {
    getDiagnostics: (uri) => {
      __diag.calls.push(uri ? uri.fsPath : null);
      return __diag.all;
    }
  },
  commands: { executeCommand: async () => undefined, registerCommand: () => disposable },
  SecretStorage: {},
  ThemeIcon: { fromString: () => undefined },
  workspace2: null
};

module.exports.__setConfig = (o) => { for (const k of Object.keys(o)) { if (o[k] === undefined) delete __cfgValues[k]; else __cfgValues[k] = o[k]; } };
module.exports.__resetConfig = () => { for (const k of Object.keys(__cfgValues)) delete __cfgValues[k]; };
module.exports.__fs = __fs;
module.exports.__diag = __diag;
module.exports.__find = __find;
module.exports.__resetInstrumentation = () => {
  __fs.statCalls.length = 0;
  __fs.readCalls.length = 0;
  __fs.files.clear();
  __diag.calls.length = 0;
  __diag.all.length = 0;
  __find.calls = 0;
  __find.results = [];
};
