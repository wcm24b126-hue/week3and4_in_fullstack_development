const { check, report } = require("./harness.cjs");
const vscode = require("vscode");
const OUT = require("./harness.cjs").OUT;

function memento(i = {}) { const s = { ...i }; return { get: (k, d) => (k in s ? s[k] : d), update: async (k, v) => { if (v === undefined) delete s[k]; else s[k] = v; }, _s: s }; }

async function main() {
  // ---- trust gate: no file context at all in an untrusted workspace
  const { buildContext } = require(`${require("./harness.cjs").OUT}/context/engine.js`);
  const cfg = { includeSelection: true, maxFileContextChars: 10000, excludeGlobs: [], maxContextFiles: 5, maxOpenTabs: 3, systemPrompt: "", temperature: 0.2, maxOutputTokens: 1024, streaming: true, provider: "groq", model: "x", saveHistory: true, maxSavedConversations: 25, autoHandoff: false, telemetryNotice: false, sendSelectionOnAsk: true, includeDiagnostics: true, copilotStatusBar: true };
  vscode.workspace.isTrusted = false;
  const untrusted = await buildContext({ mentions: ["src/extension.ts"], query: "explain", includeSelection: true, config: cfg });
  check("untrusted returns no files", untrusted.files.length === 0, JSON.stringify(untrusted.files));
  check("untrusted returns no text", untrusted.text === "", JSON.stringify(untrusted.text));
  check("untrusted not marked truncated", untrusted.truncated === false);

  // ---- saveHistory:false must not blank the view
vscode.workspace.getConfiguration("x").get("saveHistory", true);
require("./stub-vscode.js").__setConfig({ saveHistory: false });
  const { HistoryStore } = require(`${require("./harness.cjs").OUT}/history.js`);
  const g = memento();
  const h = new HistoryStore(g);
  const conv = h.create();
  conv.messages.push({ id: "m", role: "user", content: "hello", mode: "chat", createdAt: Date.now() });
  h.save(conv);
  check("in-memory history works with saveHistory off", h.active() !== undefined && h.active().messages.length === 1);
  check("nothing persisted to disk when off", !g._s["knightrider.conversations"]);
  check("active id still persisted", g._s["knightrider.activeConversation"] === conv.id);
  h.clear();
  check("clear still works with saveHistory off", h.list().length === 0 && h.activeId() === undefined);
  check("clear then ensureActive makes a fresh chat", !!h.ensureActive().id);
  h.save(h.ensureActive());
  check("active survives repeated save", h.activeId() === h.list()[0].id);

  // ================= extension-host responsiveness =================
  // The 2.1.x context engine stalled the editor because it (a) asked for
  // every diagnostic in the window, (b) leaked an open document per mention,
  // and (c) read whole files just to keep a clipped prefix. These assert the
  // 2.2.0 behaviour so it cannot quietly come back.
  const stub = require("./stub-vscode.js");
  const { invalidateFileIndex } = require(`${OUT}/context/fileIndex.js`);
  const editorDoc = (text = "hello world") => ({
    uri: stub.Uri.file("/repo/src/active.ts"),
    languageId: "typescript",
    getText: () => text
  });

  vscode.workspace.isTrusted = true;
  vscode.workspace.findFiles = stub.workspace.findFiles;

  const baseCfg = { ...cfg, autoContext: false, includeCurrentFile: false, maxFileContextChars: 40000 };

  // -- scoped diagnostics ------------------------------------------------
  stub.__resetInstrumentation();
  stub.__diag.all = [
    { severity: 0, range: { start: { line: 2, character: 4 } }, message: "bad thing", code: "TS2322" }
  ];
  vscode.window.activeTextEditor = { document: editorDoc(), selection: { isEmpty: true } };
  invalidateFileIndex();
  const diagCtx = await buildContext({ mentions: [], query: "", includeSelection: false, config: baseCfg });
  check("diagnostics are requested for a uri", stub.__diag.calls.length === 1 && typeof stub.__diag.calls[0] === "string", JSON.stringify(stub.__diag.calls));
  check("diagnostics never requested unscoped", stub.__diag.calls.every((c) => c !== null), JSON.stringify(stub.__diag.calls));
  check("diagnostics text is attached", /TS2322/.test(diagCtx.diagnostics), diagCtx.diagnostics);

  // -- the file index is not built when nothing can use it ---------------
  stub.__resetInstrumentation();
  vscode.window.activeTextEditor = { document: editorDoc(), selection: { isEmpty: true } };
  invalidateFileIndex();
  await buildContext({ mentions: [], query: "", includeSelection: false, config: baseCfg });
  check("no workspace scan when there is nothing to rank", stub.__find.calls === 0, `findFiles calls=${stub.__find.calls}`);

  // -- a mention does need the index, and must not open a document -------
  stub.__resetInstrumentation();
  stub.__find.results = [{ fsPath: "/repo/src/target.ts", path: "/repo/src/target.ts", scheme: "file" }];
  stub.__fs.files.set("/repo/src/target.ts", "const target = 1;\n");
  vscode.window.activeTextEditor = { document: editorDoc(), selection: { isEmpty: true } };
  invalidateFileIndex();
  const mentionCtx = await buildContext({ mentions: ["src/target.ts"], query: "", includeSelection: false, config: baseCfg });
  check("mention builds the index", stub.__find.calls === 1, `findFiles calls=${stub.__find.calls}`);
  check("mention attaches the file", mentionCtx.files.some((f) => f.path.endsWith("target.ts")), JSON.stringify(mentionCtx.files));
  check("file read through fs.readFile", stub.__fs.readCalls.includes("/repo/src/target.ts"), JSON.stringify(stub.__fs.readCalls));
  check("file size checked before reading", stub.__fs.statCalls.includes("/repo/src/target.ts"), JSON.stringify(stub.__fs.statCalls));

  // -- oversized files are skipped, never materialised -------------------
  stub.__resetInstrumentation();
  stub.__find.results = [{ fsPath: "/repo/src/bundle.js", path: "/repo/src/bundle.js", scheme: "file" }];
  stub.__fs.files.set("/repo/src/bundle.js", "x".repeat(600 * 1024));
  vscode.window.activeTextEditor = { document: editorDoc(), selection: { isEmpty: true } };
  invalidateFileIndex();
  const bigCtx = await buildContext({ mentions: ["src/bundle.js"], query: "", includeSelection: false, config: baseCfg });
  check("oversized file is not attached", !bigCtx.files.some((f) => f.path.endsWith("bundle.js")), JSON.stringify(bigCtx.files));
  check("oversized file is never read", !stub.__fs.readCalls.includes("/repo/src/bundle.js"), JSON.stringify(stub.__fs.readCalls));

  // -- binary content is rejected rather than sent to the model ----------
  stub.__resetInstrumentation();
  stub.__find.results = [{ fsPath: "/repo/src/blob.bin", path: "/repo/src/blob.bin", scheme: "file" }];
  stub.__fs.files.set("/repo/src/blob.bin", "PK\u0003\u0004\u0000\u0000binary");
  vscode.window.activeTextEditor = { document: editorDoc(), selection: { isEmpty: true } };
  invalidateFileIndex();
  const binCtx = await buildContext({ mentions: ["src/blob.bin"], query: "", includeSelection: false, config: baseCfg });
  check("binary file is not attached", !binCtx.files.some((f) => f.path.endsWith("blob.bin")), JSON.stringify(binCtx.files));

  // -- a file under the clip limit is still truncated and reported -------
  stub.__resetInstrumentation();
  stub.__find.results = [{ fsPath: "/repo/src/long.ts", path: "/repo/src/long.ts", scheme: "file" }];
  stub.__fs.files.set("/repo/src/long.ts", "y".repeat(20000));
  vscode.window.activeTextEditor = { document: editorDoc(), selection: { isEmpty: true } };
  invalidateFileIndex();
  const longCtx = await buildContext({ mentions: ["src/long.ts"], query: "", includeSelection: false, config: baseCfg });
  const longEntry = longCtx.files.find((f) => f.path.endsWith("long.ts"));
  check("long file reports true length", !!longEntry && longEntry.chars === 20000, JSON.stringify(longEntry));
  check("long file marked truncated", !!longEntry && longEntry.truncated === true, JSON.stringify(longEntry));
  check("long file clipped in prompt", longCtx.text.length < 20000, `prompt chars=${longCtx.text.length}`);

  // -- ranking: precomputed lowercase must not change the ordering -------
  const { rankFiles } = require(`${OUT}/context/fileIndex.js`);
  const raw = [
    { relPath: "src/views/chatView.ts", name: "chatView.ts" },
    { relPath: "src/chatViewHelper.ts", name: "chatViewHelper.ts" },
    { relPath: "test/chatView.test.ts", name: "chatView.test.ts" }
  ];
  const pre = raw.map((f) => ({ ...f, relLower: f.relPath.toLowerCase(), nameLower: f.name.toLowerCase() }));
  const a = rankFiles({ all: raw, byRelPath: new Map() }, "chatView", 3).map((f) => f.relPath).join("|");
  const b = rankFiles({ all: pre, byRelPath: new Map() }, "chatView", 3).map((f) => f.relPath).join("|");
  check("precomputed lowercase preserves ranking", a === b, `${a} vs ${b}`);

  vscode.workspace.isTrusted = false;
  stub.__resetInstrumentation();

  // ---- history budget
  process.exit(report("suite"));
}
main();
