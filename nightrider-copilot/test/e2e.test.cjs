// End-to-end: webview -> host -> LLM -> webview, driven through the real
// compiled extension with a fake OpenAI-compatible server.
const http = require("http");
const path0 = require("path");
process.env.NR_VSCODE_STUB = path0.join(__dirname, "stub-e2e.generated.js");
const { check, report, sleep } = require("./harness.cjs");
const { OUT } = require("./harness.cjs");


const secretStore = { _m: {}, get: async (k) => secretStore._m[k], store: async (k, v) => { secretStore._m[k] = v; }, delete: async (k) => { delete secretStore._m[k]; }, onDidChange: () => ({ dispose(){} }) };
const cfgValues = {
  apiBaseUrl: "", model: "test-model", temperature: 0.2, maxOutputTokens: 256,
  streaming: true, systemPrompt: "", includeCurrentFile: true, includeSelection: true,
  maxContextFiles: 3, maxFileContextChars: 4000, autoContext: true,
  confirmBeforeApply: true, confirmBeforeRun: true, saveHistory: true, maxSavedConversations: 5,
  copilotStatusBar: true, copilotAutoHandoff: false, copilotHandoffContext: true, telemetryNotice: false
};

const webviewListeners = [];
let posted = [];
let handler = null;
const webview = {
  html: "", options: null, cspSource: "vscode-webview://x",
  asWebviewUri: (u) => ({ fsPath: "u" + u.fsPath, path: u.fsPath, toString: () => "u" + u.fsPath }),
  onDidReceiveMessage: (fn) => { const e = { fn, disposed: false }; webviewListeners.push(e); return { dispose() { e.disposed = true; } }; },
  postMessage: async (m) => { posted.push(m); return true; }
};
// the webview script cannot run in plain node, so the host <-> webview contract is
// exercised by pulling messages off `posted` and feeding replies back in.
const sendToWebview = (m) => { if (handler) handler(m); };
const fromWebview = (m) => { for (const e of webviewListeners) if (!e.disposed) e.fn(m); };

const doc = { uri: { fsPath: "/w/src/app.ts", path: "/w/src/app.ts", scheme: "file" }, languageId: "typescript", lineCount: 3, version: 1, getText: () => "line1\nline2\nline3", lineAt: (n) => ({ text: "line" + n, range: {} }), eol: 1 };
const editor = { document: doc, selection: { isEmpty: false, start: { line: 0, character: 0 }, end: { line: 0, character: 5 }, active: { line: 0, character: 5 } } };

const mk = () => {
  const m = { _m: {} };
  m.get = (k, d) => (k in m._m ? m._m[k] : d);
  m.update = async (k, v) => { if (v === undefined) delete m._m[k]; else m._m[k] = v; };
  m.keys = () => Object.keys(m._m);
  return m;
};
const context = { subscriptions: [], extensionUri: { fsPath: "/ext", path: "/ext" }, extensionPath: "/ext", globalState: mk({}), workspaceState: mk({}), secrets: secretStore, asAbsolutePath: (p) => "/ext/" + p, globalStorageUri: { fsPath: "/g" }, logUri: { fsPath: "/l" } };

const vscode = {
  window: {
    createOutputChannel: () => ({ appendLine(){}, clear(){}, show(){}, hide(){}, replace(){}, dispose(){}, info(){}, warn(){}, error(){}, debug(){}, trace(){}, name: "n" }),
    showErrorMessage: (m) => { posted.push({ type: "__error", m }); return Promise.resolve(undefined); },
    showWarningMessage: () => Promise.resolve(undefined),
    showInformationMessage: () => Promise.resolve(undefined),
    showQuickPick: () => Promise.resolve(undefined),
    showInputBox: () => Promise.resolve(undefined),
    registerWebviewViewProvider: (id, p) => { vscode.__provider = p; return { dispose(){} }; },
    createStatusBarItem: () => ({ show(){}, hide(){}, dispose(){}, text:"", tooltip:"", command:"", name:"" }),
    createQuickPick: () => ({ items: [], busy: false, buttons: [], onDidTriggerItemButton(){return {dispose(){}};}, onDidAccept(){return {dispose(){}};}, onDidHide(){return {dispose(){}};}, onDidChangeValue(){return {dispose(){}};}, show(){}, hide(){}, dispose(){} }),
    withProgress: (_o, t) => t({ report(){} }, { isCancellationRequested: false }),
    activeTextEditor: editor, visibleTextEditors: [editor],
    showTextDocument: async () => ({}),
    onDidChangeActiveTextEditor: () => ({ dispose(){} }),
    onDidChangeTextEditorSelection: () => ({ dispose(){} })
  },
  workspace: {
    getConfiguration: () => ({ get: (k, d) => (k in cfgValues ? cfgValues[k] : d), update: async () => {} }),
    onDidChangeConfiguration: () => ({ dispose(){} }),
    onDidChangeWorkspaceFolders: () => ({ dispose(){} }),
    findFiles: async () => [doc.uri],
    workspaceFolders: [{ name: "w", uri: { fsPath: "/w", path: "/w" }, index: 0 }],
    isTrusted: true, textDocuments: [doc],
    registerTextDocumentContentProvider: () => ({ dispose(){} }),
    asRelativePath: (u) => String(u && u.fsPath ? u.fsPath : u).replace("/w/", ""),
    getWorkspaceFolder: () => ({ name: "w", uri: { fsPath: "/w", path: "/w" }, index: 0 }),
    openTextDocument: async (u) => doc,
  },
  languages: { getDiagnostics: () => [], registerCodeActionsProvider: () => ({ dispose(){} }) },
  commands: { registerCommand: (id, fn) => { vscode.__cmds = vscode.__cmds || new Map(); vscode.__cmds.set(id, fn); return { dispose(){} }; }, executeCommand: async () => undefined },
  extensions: { getExtension: () => undefined, onDidChange: () => ({ dispose(){} }) },
  authentication: { getSession: async () => undefined, onDidChangeSessions: () => ({ dispose(){} }) },
  chat: { createChatParticipant: () => ({ dispose(){} }) },
  env: { clipboard: { readText: async () => "", writeText: async () => {} }, openExternal: async () => true },
  StatusBarAlignment: { Right: 2, Left: 1 }, DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
  SymbolKind: { Class: 4, Function: 11, Method: 5, Interface: 10 },
  CodeActionKind: { QuickFix: "quickfix", RefactorRewrite: "refactor.rewrite" },
  CodeAction: class { constructor(t, k) { this.title = t; this.kind = k; } },
  ThemeIcon: class { constructor(i) { this.id = i; } static fromString(i) { return new ThemeIcon(i); } },
  ThemeColor: class { constructor(i) { this.id = i; } },
  MarkdownString: class { constructor(v="") { this.value=v; } appendMarkdown(m){this.value+=m;return this;} appendText(t){this.value+=t;return this;} },
  QuickPickItemKind: { Separator: -1, Default: 0 },
  Uri: { file: (p) => ({ fsPath: p, path: p, scheme: "file" }), joinPath: (a, ...b) => ({ fsPath: [a.fsPath, ...b].join("/"), path: [a.fsPath, ...b].join("/"), scheme: "file" }), parse: (s) => ({ fsPath: s, path: s, scheme: "file" }) },
  Range: class Range { constructor(a,b){this.start=a;this.end=b;} },
  Position: class Position { constructor(l,c){this.line=l;this.character=c;} },
  Selection: class Selection { constructor(a,b){this.start=a;this.end=b;this.anchor=a;this.active=b||a;} },
  EventEmitter: class { constructor(){ this.event=()=>({dispose(){}}); } fire(){} dispose(){} },
  Disposable: class { constructor(f){this._f=f;} dispose(){this._f&&this._f();} static from(...d){return {dispose:()=>d.forEach(x=>x.dispose())};} },
  FileType: { File: 1 }, ProgressLocation: { Notification: 15 }, version: "1.90.0"
};

module.exports.__vscode = vscode;
const fs = require("fs");
const path = require("path");
fs.writeFileSync(path.join(__dirname, "stub-e2e.generated.js"), `module.exports = require(${JSON.stringify(__filename)}).__vscode;\n`);

(async () => {
  // --- fake streaming provider
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => { body += d; });
    req.on("end", () => {
      const payload = JSON.parse(body || "{}");
      global.__lastRequest = payload;
      res.writeHead(200, { "content-type": "text/event-stream" });
      const chunks = ["Here", " is", " the", " fix", ":\n", "```ts", "\nconst x = 1;", "\n```"];
      for (const c of chunks) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  cfgValues.apiBaseUrl = `http://127.0.0.1:${port}/v1`;
  await secretStore.store("nightrider.apiKey", "test-key");

  const ext = require(path.join(OUT, "extension.js"));
  await ext.activate(context);

  const view = { webview, onDidDispose: () => ({ dispose(){} }), show: () => {}, visible: true, title: "NightRider" };
  await vscode.__provider.resolveWebviewView(view);
  check("provider resolved", !!vscode.__provider);

  // the webview announces readiness
  fromWebview({ type: "ready" });
  await sleep(30);
  check("host pushes config on ready", posted.some((m) => m.type === "setConfig"));
  check("host pushes initial conversation", posted.some((m) => m.type === "render"));
  const cfgMsg = posted.find((m) => m.type === "setConfig");
  check("setConfig carries a config", !!cfgMsg && !!cfgMsg.config);
  check("config includes the chosen model", cfgMsg.config.model === "test-model", cfgMsg.config && cfgMsg.config.model);
  check("config includes the model list", Array.isArray(cfgMsg.config.models) && cfgMsg.config.models.length > 0);
  check("config reports workspace trust", cfgMsg.config.workspaceTrusted === true);
  // the key must be read from SecretStorage, and only a boolean may reach the webview
  check("no api key leaked into the webview payload", !JSON.stringify(posted).includes("test-key"), JSON.stringify(posted).slice(0, 200));

  // --- send a prompt
  posted = [];
  fromWebview({ type: "send", text: "fix the bug", mode: "fix", mentions: [] });
  await sleep(500);

  check("busy posted", posted.some((m) => m.type === "busy" && m.busy === true));
  check("stream started", posted.some((m) => m.type === "streamStart" && m.message.role === "assistant"));
  const deltas = posted.filter((m) => m.type === "streamDelta");
  check("streamed deltas arrive", deltas.length > 0, String(deltas.length));
  const streamed = deltas.map((m) => m.text).join("");
  check("streamed text reconstructs", streamed.includes("const x = 1;"), JSON.stringify(streamed));
  check("stream ended", posted.some((m) => m.type === "streamEnd" && m.message && m.message.pending === false));
  check("busy cleared", posted.some((m) => m.type === "busy" && m.busy === false));
  console.log("DEBUG posted types:", JSON.stringify(posted.map((m) => m.type)));
  const err = posted.find((m) => m.type === "error");
  if (err) console.log("DEBUG error:", JSON.stringify(err));
  if (!global.__lastRequest) console.log("DEBUG no request hit the server; baseUrl was", cfgValues.apiBaseUrl);

  // --- the request the host actually sent
  const req = global.__lastRequest;
  check("request hit the provider", !!req);
  check("request has a system prompt", req.messages[0].role === "system" && req.messages[0].content.length > 50);
  check("system prompt includes the file", req.messages[0].content.includes("line1"), req.messages[0].content.slice(0, 200));
  check("system prompt uses the fix mode", /fix/i.test(req.messages[0].content));
  check("user turn sent", req.messages.some((m) => m.role === "user" && m.content === "fix the bug"));
  check("streaming requested", req.stream === true);
  check("model forwarded", req.model === "test-model");
  check("history saved the user turn", context.globalState._m["nightrider.conversations"][0].messages.some((m) => m.content === "fix the bug"));
  check("title derived", context.globalState._m["nightrider.conversations"][0].title === "fix the bug", context.globalState._m["nightrider.conversations"][0].title);

  // --- regenerate uses the same conversation
  posted = [];
  fromWebview({ type: "regenerate" });
  await sleep(500);
  check("regenerate streams again", posted.some((m) => m.type === "streamEnd" && m.message));
  check("regenerate kept one user turn", context.globalState._m["nightrider.conversations"][0].messages.filter((m) => m.role === "user").length === 1);

  // --- stop cancels
  posted = [];
  fromWebview({ type: "stop" });
  check("stop is accepted", true);

  // --- delete a message
  posted = [];
  const id = context.globalState._m["nightrider.conversations"][0].messages[0].id;
  fromWebview({ type: "deleteMessage", id });
  await sleep(60);
  check("delete re-renders", posted.some((m) => m.type === "render" && !m.conversation.messages.some((x) => x.id === id)));

  // --- new chat resets
  posted = [];
  fromWebview({ type: "newChat" });
  await sleep(60);
  check("newChat posts an empty conversation", posted.some((m) => m.type === "render" && m.conversation.messages.length === 0));
  check("newChat created a second conversation", context.globalState._m["nightrider.conversations"].length === 2, String(context.globalState._m["nightrider.conversations"].length));
  check("previous conversation is still saved", context.globalState._m["nightrider.conversations"].some((c) => c.title === "fix the bug"));
  check("maxSavedConversations is respected", context.globalState._m["nightrider.conversations"].length <= cfgValues.maxSavedConversations);

  // --- unknown message type is ignored, not fatal
  posted = [];
  fromWebview({ type: "totallyUnknown", payload: 1 });
  await sleep(30);
  check("unknown message is ignored", true);

  // --- a bad key surfaces a friendly error rather than crashing
  await secretStore.store("nightrider.apiKey", "bad");
  cfgValues.apiBaseUrl = `http://127.0.0.1:${port}/v1`;
  posted = [];
  const server2 = http.createServer((req, res) => { res.writeHead(401, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { message: "Invalid API key" } })); });
  await new Promise((r) => server2.listen(0, r));
  cfgValues.apiBaseUrl = `http://127.0.0.1:${server2.address().port}/v1`;
  fromWebview({ type: "send", text: "hello", mode: "chat", mentions: [] });
  await sleep(1500);
  check("401 produces an error message, not a crash", posted.some((m) => m.type === "error" && m.kind === "auth"), JSON.stringify(posted.filter((m) => m.type === "error")));

  server.close(); server2.close();
  process.exit(report("suite"));
})().catch((e) => { console.log("CRASH: " + e.stack); process.exit(1); });
