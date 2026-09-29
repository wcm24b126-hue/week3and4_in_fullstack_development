const path = require("path");
const fs = require("fs");
const { JSDOM } = require("jsdom");
const { check, report } = require("./harness.cjs");
const MEDIA = path.join(__dirname, "..", "media");
// Build the real webview HTML the same way ChatViewProvider does: the host
// generates it, so the test must not hand-write its own copy.
const { OUT } = require("./harness.cjs");
const { ChatViewProvider } = require(path.join(OUT, "views", "chatView.js"));
const vscodeStub = require("./stub-vscode.js");
const webview = {
  cspSource: "vscode-webview://test",
  asWebviewUri: (u) => ({ fsPath: "vscode-webview://test" + u.fsPath, path: u.fsPath, toString: () => "vscode-webview://test" + u.fsPath })
};
// minimal collaborators: only the constructor's event subscriptions are needed
// to render the HTML shell
const noopEvent = () => ({ dispose() {} });
const provider = new ChatViewProvider(
  { extensionUri: { fsPath: path.join(__dirname, ".."), path: path.join(__dirname, "..") } },
  { onDidChangeKey: noopEvent },
  { onDidChange: noopEvent },
  { applyToFile: async () => true },
  { onDidChange: noopEvent }
);
const html = provider["_html"](webview);


function boot() {
  const dom = new JSDOM(html, { runScripts: "outside-only", pretendToBeVisual: true, url: "https://localhost/" });
  const w = dom.window;
  const sent = [];
  w.acquireVsCodeApi = () => ({
    postMessage: (m) => sent.push(m),
    getState: () => w.__state,
    setState: (s) => { w.__state = s; }
  });
  w.__state = null;
  for (const f of ["highlight.js", "markdown.js", "main.js"]) {
    w.eval(fs.readFileSync(`${MEDIA}/${f}`, "utf8"));
  }
  w.__host = (msg) => {
    const ev = new w.MessageEvent("message", { data: msg });
    w.dispatchEvent(ev);
  };
  w.__send = sent;
  w.__tick = (ms = 200) => new Promise((r) => setTimeout(r, ms));
  return w;
}

const CFG = {
  model: "llama-3.3-70b-versatile", mode: "chat", streaming: true, autoContext: true,
  includeCurrentFile: true, workspaceTrusted: true, contextChars: 24000,
  models: [
    { id: "llama-3.3-70b-versatile", label: "Llama 3.3 70B", hint: "Balanced" },
    { id: "llama-3.1-8b-instant", label: "Llama 3.1 8B", hint: "Fast" }
  ]
};
const STATUS = { provider: "Groq", model: "Llama 3.3 70B", copilotInstalled: true, copilotSignedIn: true, copilotLimited: false, hasKey: true };

(async () => {
  const w = boot();
  const d = w.document;
  const input = d.getElementById("input");
  const msgs = d.getElementById("messages");
  const send = d.getElementById("sendBtn");

  w.__host({ type: "init", hasKey: true, config: CFG, conversation: { id: "c1", title: "t", createdAt: 1, updatedAt: 1, messages: [] } });
  w.__host({ type: "setStatus", status: STATUS });
  await w.__tick();

  check("empty state rendered", !!msgs.querySelector(".nr-empty"));
  check("quick actions rendered", d.querySelectorAll(".nr-chip").length === 7, String(d.querySelectorAll(".nr-chip").length));
  check("model options rendered", d.getElementById("modelPicker").options.length === 2);
  check("model selected", d.getElementById("modelPicker").value === CFG.model);
  check("status line", /Groq/.test(d.getElementById("subLine").textContent), d.getElementById("subLine").textContent);
  check("ready posted on boot", w.__send.some((m) => m.type === "ready"));

  // --- sending
  input.value = "explain this";
  input.dispatchEvent(new w.Event("input"));
  send.click();
  await w.__tick();
  const sentMsg = w.__send.find((m) => m.type === "send");
  check("send posts text+mode+mentions", sentMsg && sentMsg.text === "explain this" && sentMsg.mode === "chat" && Array.isArray(sentMsg.mentions), JSON.stringify(sentMsg));
  check("composer cleared", input.value === "");

  // --- user message + streaming
  w.__host({ type: "render", conversation: { id: "c1", title: "t", createdAt: 1, updatedAt: 1, messages: [
    { id: "u1", role: "user", content: "explain this", mode: "chat", createdAt: Date.now() }
  ] } });
  w.__host({ type: "busy", busy: true });
  w.__host({ type: "streamStart", message: { id: "a1", role: "assistant", content: "", mode: "chat", createdAt: Date.now(), pending: true } });
  await w.__tick(50);
  check("stream caret present", !!msgs.querySelector(".nr-caret"));
  check("stop button visible when busy", d.getElementById("stopBtn").hidden === false && send.hidden === true);

  for (const chunk of ["Here is ", "the answer:\n\n```ts\nconst a = 1;\n```\n\n- point one\n- point two"]) {
    w.__host({ type: "streamDelta", messageId: "a1", text: chunk });
  }
  await w.__tick(250);
  const streaming = msgs.querySelector('[data-id="a1"]');
  check("streamed markdown heading/list", /point one/.test(streaming.innerHTML) && /<li>/.test(streaming.innerHTML), streaming.innerHTML.slice(0, 120));
  check("streamed code block present", !!streaming.querySelector(".nr-code"));

  w.__host({ type: "streamEnd", message: { id: "a1", role: "assistant", content: "Here is the answer:\n\n```ts\nconst a = 1;\n```\n\n- point one\n- point two", mode: "chat", createdAt: Date.now(), model: "llama-3.3-70b-versatile" } });
  w.__host({ type: "busy", busy: false });
  await w.__tick(50);
  const final = msgs.querySelector('[data-id="a1"]');
  check("final message rendered once", msgs.querySelectorAll('[data-id="a1"]').length === 1, String(msgs.querySelectorAll('[data-id="a1"]').length));
  check("caret removed after stream end", !final.querySelector(".nr-caret"));
  check("regenerate button on last assistant", !!final.querySelector('[title="Regenerate"]'));
  check("model shown in header", /llama-3.3-70b/.test(final.textContent));
  check("stop hidden again", d.getElementById("stopBtn").hidden === true);

  // --- code block buttons
  const code = final.querySelector(".nr-code code");
  check("highlight spans emitted", !!code.querySelector("span"), "no spans");
  check("code textContent is source", code.textContent === "const a = 1;", JSON.stringify(code.textContent));
  const applyBtn = final.querySelector('.nr-code-btn[data-action="apply"]');
  applyBtn.click();
  const applyMsg = w.__send.find((m) => m.type === "codeAction" && m.action === "apply");
  check("apply posts exact code", applyMsg && applyMsg.code === "const a = 1;" && applyMsg.language === "ts", JSON.stringify(applyMsg));

  // --- shell block shows Run
  w.__host({ type: "render", conversation: { id: "c1", title: "t", createdAt: 1, updatedAt: 1, messages: [
    { id: "u2", role: "user", content: "build it", mode: "chat", createdAt: Date.now() },
    { id: "a2", role: "assistant", content: "Run:\n```bash\nnpm run compile\n```", mode: "chat", createdAt: Date.now() }
  ] } });
  await w.__tick(50);
  const shell = msgs.querySelector('[data-id="a2"] .nr-code');
  check("shell block has Run", !!shell.querySelector('[data-action="run"]'));
  check("shell block has no Apply", !shell.querySelector('[data-action="apply"]'));
  shell.querySelector('[data-action="run"]').click();
  const runMsg = w.__send.find((m) => m.type === "codeAction" && m.action === "run");
  check("run posts command", runMsg && runMsg.code === "npm run compile", JSON.stringify(runMsg));

  // --- mentions
  input.value = "look at @src/ext";
  input.dispatchEvent(new w.Event("input"));
  // The mention autocomplete is debounced (180ms) so a burst of keystrokes
  // costs one round-trip instead of one per character. Wait past the debounce.
  await w.__tick(320);
  const queryMsg = w.__send.filter((m) => m.type === "mentionQuery").pop();
  check("mention query posted", queryMsg && queryMsg.query === "src/ext", JSON.stringify(queryMsg));
  w.__host({ type: "mentionResults", files: [{ path: "src/extension.ts", name: "extension.ts" }, { path: "src/views/chatView.ts", name: "chatView.ts" }] });
  await w.__tick(50);
  check("popover open with results", d.getElementById("popover").hidden === false && d.querySelectorAll(".nr-pop-item").length === 2);
  input.dispatchEvent(new w.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  await w.__tick(20);
  check("arrow moves selection", d.querySelectorAll(".nr-pop-item")[1].classList.contains("sel"));
  input.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await w.__tick(50);
  check("mention inserted into text", /@chatView\.ts/.test(input.value), input.value);
  check("mention chip shown", d.querySelectorAll(".nr-mention").length === 1, d.getElementById("mentionBar").innerHTML.slice(0, 120));
  check("popover closed after accept", d.getElementById("popover").hidden === true);
  send.click();
  await w.__tick(50);
  const withMention = w.__send.filter((m) => m.type === "send").pop();
  check("send carries mentions", withMention.mentions.length === 1 && withMention.mentions[0] === "src/views/chatView.ts", JSON.stringify(withMention.mentions));

  // --- error path
  w.__host({ type: "streamStart", message: { id: "a3", role: "assistant", content: "", mode: "chat", createdAt: Date.now(), pending: true } });
  await w.__tick(30);
  w.__host({ type: "error", messageId: "a3", text: "Invalid API Key. Check the API key for the configured provider.", kind: "auth" });
  await w.__tick(50);
  check("error box rendered", /Invalid API Key/.test(msgs.textContent));
  check("error notice shown", d.getElementById("notice").hidden === false && d.getElementById("notice").className.includes("error"));
  check("retry button on error", !!msgs.querySelector('[title="Try again"]'));

  // --- delete + mentions chip removal + stop
  const before = msgs.querySelectorAll(".nr-msg").length;
  msgs.querySelector('[data-id="a3"] [title="Delete message"]').click();
  await w.__tick(50);
  const del = w.__send.filter((m) => m.type === "deleteMessage").pop();
  check("delete posts the message id", del && del.id === "a3", JSON.stringify(del));
  // host round-trip: conversation without a3 comes back as a render message
  w.__host({ type: "render", conversation: { id: "c1", title: "t", createdAt: 1, updatedAt: 1, messages: [
    { id: "u2", role: "user", content: "build it", mode: "chat", createdAt: Date.now() },
    { id: "a2", role: "assistant", content: "Run:\n```bash\nnpm run compile\n```", mode: "chat", createdAt: Date.now() }
  ] } });
  await w.__tick(50);
  check("message removed after host render", !msgs.querySelector('[data-id="a3"]') && msgs.querySelectorAll(".nr-msg").length === before - 1, `${before} -> ${msgs.querySelectorAll(".nr-msg").length}`);

  w.__host({ type: "busy", busy: true });
  d.getElementById("stopBtn").click();
  check("stop posts stop", w.__send.some((m) => m.type === "stop"));

  // --- status popover
  d.getElementById("statusBtn").click();
  await w.__tick(30);
  check("status popover lists copilot switch", [...d.querySelectorAll(".nr-pop-item")].some((n) => /Copilot/.test(n.textContent)));
  d.querySelectorAll(".nr-pop-item")[0].dispatchEvent(new w.MouseEvent("mousedown", { bubbles: true }));
  await w.__tick(30);
  const cmd = w.__send.find((m) => m.type === "command");
  check("status action posts whitelisted command", cmd && cmd.id === "knightrider.copilot.switch", JSON.stringify(cmd));

  // --- copilot limited status styling
  w.__host({ type: "setStatus", status: { ...STATUS, copilotLimited: true } });
  await w.__tick(30);
  check("copilot limited changes dot + subline", d.getElementById("statusDot").className.includes("warn") && /out of tokens/.test(d.getElementById("subLine").textContent), d.getElementById("subLine").textContent);

  // --- model change
  const picker = d.getElementById("modelPicker");
  picker.value = "llama-3.1-8b-instant";
  picker.dispatchEvent(new w.Event("change"));
  await w.__tick(30);
  check("model change posts setModel", w.__send.some((m) => m.type === "setModel" && m.id === "llama-3.1-8b-instant"));

  // --- XSS: hostile model output
  w.__host({ type: "render", conversation: { id: "c1", title: "t", createdAt: 1, updatedAt: 1, messages: [
    { id: "a4", role: "assistant", content: '<img src=x onerror="window.__pwned=1">\n\n<script>window.__pwned=1<\/script>\n\n[bad](javascript:window.__pwned=1)\n\n```js\nconst s = "<script>";\n```', mode: "chat", createdAt: Date.now() }
  ] } });
  await w.__tick(50);
  check("no script injected from output", w.__pwned === undefined && d.querySelectorAll('[data-id="a4"] script').length === 0);
  check("no javascript: link", ![...d.querySelectorAll('[data-id="a4"] a')].some((a) => a.getAttribute("href") === "javascript:window.__pwned=1"));
  check("onerror not live", ![...d.querySelectorAll('[data-id="a4"] img')].some((i) => i.hasAttribute("onerror")));
  check("code block text safe", d.querySelector('[data-id="a4"] .nr-code code').textContent === 'const s = "<script>";');

  // --- persistence
  input.value = "draft text";
  input.dispatchEvent(new w.Event("input"));
  check("draft persisted via setState", w.__state && w.__state.draft === "draft text", JSON.stringify(w.__state));

  process.exit(report("suite"));
})();
