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
  check("nothing persisted to disk when off", !g._s["nightrider.conversations"]);
  check("active id still persisted", g._s["nightrider.activeConversation"] === conv.id);
  h.clear();
  check("clear still works with saveHistory off", h.list().length === 0 && h.activeId() === undefined);
  check("clear then ensureActive makes a fresh chat", !!h.ensureActive().id);
  h.save(h.ensureActive());
  check("active survives repeated save", h.activeId() === h.list()[0].id);

  // ---- history budget
  process.exit(report("suite"));
}
main();
