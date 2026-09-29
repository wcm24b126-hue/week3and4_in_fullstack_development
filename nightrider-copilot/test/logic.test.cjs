const { check, report } = require("./harness.cjs");
const OUT = require("./harness.cjs").OUT;


// ---- Memento stub
function memento(initial = {}) {
  const store = { ...initial };
  return { get: (k, d) => (k in store ? store[k] : d), update: async (k, v) => { if (v === undefined) delete store[k]; else store[k] = v; }, _store: store };
}

// ---------------- history
const { HistoryStore, newMessageId, messageCounts } = require(`${require("./harness.cjs").OUT}/history.js`);
const g = memento();
const h = new HistoryStore(g);
const c1 = h.create();
check("new conversation shape", c1.title === "New chat" && c1.messages.length === 0 && !!c1.id);
c1.messages.push({ id: "m1", role: "user", content: "How do I fix the parser?\nSecond line", mode: "chat", createdAt: Date.now() });
h.save(c1);
check("title derived from first user message", c1.title === "How do I fix the parser?", c1.title);
const c2 = h.create();
check("active switched to newest", h.activeId() === c2.id);
check("list sorted newest first", h.list()[0].id === c2.id);
check("get by id", !!h.get(c1.id));
h.save(c1);
check("save switches active", h.activeId() === c1.id);
const restored = HistoryStore.sanitize(c1);
check("sanitize clears pending/error", restored.messages.every((m) => m.pending === false && m.error === undefined));
h.delete(c1.id);
check("delete removes", !h.get(c1.id) && h.list().length === 1);
h.clear();
check("clear empties", h.list().length === 0 && h.activeId() === undefined);
check("ensureActive creates when none", !!h.ensureActive().id);
check("messageCounts first label", messageCounts(h.ensureActive()).first === "New chat");
const longTitle = h.ensureActive();
longTitle.messages.push({ id: "z", role: "user", content: "x".repeat(200), mode: "chat", createdAt: Date.now() });
h.save(longTitle);
check("long title truncated to 48", h.get(longTitle.id).title.length === 48, String(h.get(longTitle.id).title.length));
check("newMessageId unique", newMessageId() !== newMessageId());

// ---------------- file ranking
const { rankFiles, tokenize } = require(`${require("./harness.cjs").OUT}/context/fileIndex.js`);
const files = [
  { relPath: "src/extension.ts", name: "extension.ts" },
  { relPath: "src/views/chatView.ts", name: "chatView.ts" },
  { relPath: "src/views/statusBar.ts", name: "statusBar.ts" },
  { relPath: "README.md", name: "README.md" },
  { relPath: "node_modules/x/chatView.ts", name: "chatView.ts" },
  { relPath: "test/chatView.test.ts", name: "chatView.test.ts" }
];
const idx = { all: files, byRelPath: new Map() };
check("exact filename ranks first", rankFiles(idx, "chatView", 3)[0].relPath === "src/views/chatView.ts", JSON.stringify(rankFiles(idx, "chatView", 3).map((f) => f.relPath)));
check("path fragment ranks", rankFiles(idx, "statusBar", 3).some((f) => f.name === "statusBar.ts"));
check("tokenize splits and filters", JSON.stringify(tokenize("fix the @Parser! bug")) === '["fix","the","parser","bug"]', JSON.stringify(tokenize("fix the @Parser! bug")));
check("tokenize drops 1-char", !tokenize("a b c").length);
check("rankFiles empty query", rankFiles(idx, "", 5).length === 0);
check("rankFiles no match", rankFiles(idx, "zzzzqqq", 5).length === 0);

// ---------------- clip
const { clip } = require(`${require("./harness.cjs").OUT}/context/engine.js`);
const short = "hello";
check("clip leaves short text", clip(short, 100) === short);
const long = Array.from({length: 1000}, (_, i) => String.fromCharCode(97 + (i % 26))).join("");
const clipped = clip(long, 100);
check("clip respects max length", clipped.length <= 100 + 60, String(clipped.length));
check("clip notes omission", /characters omitted/.test(clipped));
check("clip keeps head and tail", /^[a-z]{65}/.test(clipped) && /[a-z]{35}$/.test(clipped), clipped.slice(-40));
check("clip notes omission in the middle", /omitted/.test(clipped) && clipped.indexOf("omitted") > 60);

// ---------------- stripFences / providerName
const { stripFences, providerName } = require(`${require("./harness.cjs").OUT}/views/chatView.js`);
check("strips fenced ts", stripFences("```ts\nconst a = 1;\n```") === "const a = 1;");
check("strips unlabelled fence", stripFences("```\nplain\n```") === "plain");
check("leaves bare text", stripFences("const a = 1;") === "const a = 1;");
check("handles inner blank lines", stripFences("```js\na\n\nb\n```") === "a\n\nb");
check("keeps internal backticks", stripFences("```js\nconst s = `x`;\n```") === "const s = `x`;");
check("providerName groq", providerName("https://api.groq.com/openai/v1") === "Groq");
check("providerName openrouter", providerName("https://openrouter.ai/api/v1") === "OpenRouter");
check("providerName local", providerName("http://localhost:11434/v1") === "Local");
check("providerName garbage", providerName("not a url") === "provider");
check("providerName trailing slash", providerName("https://api.groq.com/openai/v1/") === "Groq");

// ---------------- prompts
const { systemPrompt } = require(`${require("./harness.cjs").OUT}/llm/prompts.js`);
const ctx = { text: "file ctx", files: [], truncated: false, symbols: "fn main", diagnostics: "e.ts:1 error" };
const sys = systemPrompt("fix", ctx, "extra rule");
check("prompt includes mode", /fix/i.test(sys));
check("prompt includes file context", sys.includes("file ctx"));
check("prompt includes symbols", sys.includes("fn main"));
check("prompt includes diagnostics", sys.includes("e.ts:1 error"));
check("prompt includes extra", sys.includes("extra rule"));
check("prompt omits empty context", !systemPrompt("chat", { ...ctx, text: "", symbols: "", diagnostics: "" }, "").includes("undefined"));

// ---------------- toAbortSignal
const { toAbortSignal } = require(`${require("./harness.cjs").OUT}/llm/client.js`);
let fired = false;
const sub = { dispose: () => { fired = true; } };
const t = { isCancellationRequested: false, onCancellationRequested: (cb) => { global.__ab = cb; return sub; } };
const bridge = toAbortSignal(t);
check("bridge starts unaborted", bridge.signal.aborted === false);
global.__ab();
check("bridge aborts on token", bridge.signal.aborted === true);
bridge.dispose();
check("bridge disposes subscription", fired === true);
const pre = toAbortSignal({ isCancellationRequested: true, onCancellationRequested: () => ({ dispose(){} }) });
check("bridge handles already-cancelled", pre.signal.aborted === true);

process.exit(report("suite"));
