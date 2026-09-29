const noop = () => {};
const __cfgValues = {};
const disposable = { dispose: noop };
const channel = { info: noop, warn: noop, error: noop, debug: noop, trace: noop, append: noop, appendLine: noop, clear: noop, show: noop, hide: noop, replace: noop, name: "x" };
module.exports = {
  window: { createOutputChannel: () => channel, showErrorMessage: noop, showInformationMessage: noop, showWarningMessage: noop, registerWebviewViewProvider: () => disposable },
  workspace: { getConfiguration: () => ({ get: (k, d) => (k in __cfgValues ? __cfgValues[k] : d) }), onDidChangeConfiguration: () => disposable, onDidChangeWorkspaceFolders: () => disposable, findFiles: async () => [] },
  Uri: { file: (p) => ({ fsPath: p, path: p, scheme: "file" }), joinPath: (a, ...b) => ({ fsPath: [a.fsPath, ...b].join("/") }), from: (o) => o },
  EventEmitter: class { constructor(){ this.event = noop; } fire(){} dispose(){} },
  extensions: { onDidChange: () => disposable, getExtension: () => undefined },
  authentication: { getSession: async () => undefined, onDidChangeSessions: () => disposable },
  Range: class {}, Position: class {}, Selection: class {}, CodeAction: class {}, CodeActionKind: { RefactorRewrite: {} },
  DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
  SymbolKind: { Class: 4, Function: 11, Method: 5, Interface: 10, TypeParameter: 25 },
  ThemeColor: class {}, StatusBarAlignment: { Right: 2 }, FileType: { File: 1 },
  env: { clipboard: { readText: async () => "", writeText: async () => {} } },
  languages: { getDiagnostics: () => [] },
  commands: { executeCommand: async () => undefined, registerCommand: () => disposable },
  SecretStorage: {},
  ThemeIcon: { fromString: () => undefined },
  workspace2: null
};

module.exports.__setConfig = (o) => { for (const k of Object.keys(o)) { if (o[k] === undefined) delete __cfgValues[k]; else __cfgValues[k] = o[k]; } };
module.exports.__resetConfig = () => { for (const k of Object.keys(__cfgValues)) delete __cfgValues[k]; };
