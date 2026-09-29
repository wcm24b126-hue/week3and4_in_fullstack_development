/* NightRider webview controller. */
(function () {
  "use strict";

  const vscode = acquireVsCodeApi();
  const MD = window.NightRiderMarkdown;

  const $ = (id) => document.getElementById(id);
  const el = {
    messages: $("messages"),
    input: $("input"),
    send: $("sendBtn"),
    stop: $("stopBtn"),
    model: $("modelPicker"),
    mode: $("modePicker"),
    quickbar: $("quickbar"),
    notice: $("notice"),
    mentionBar: $("mentionBar"),
    popover: $("popover"),
    hint: $("hint"),
    statusDot: $("statusDot"),
    statusBtn: $("statusBtn"),
    subLine: $("subLine")
  };

  const state = {
    config: null,
    status: null,
    conversation: { id: "", title: "", createdAt: 0, updatedAt: 0, messages: [] },
    busy: false,
    streamingId: null,
    streamText: "",
    mentions: [],
    mention: null,
    popover: { open: false, items: [], index: 0, kind: null },
    noticeTimer: null,
    stickToBottom: true
  };

  const QUICK_ACTIONS = [
    { id: "explain", label: "Explain" },
    { id: "fix", label: "Fix" },
    { id: "tests", label: "Tests" },
    { id: "document", label: "Docs" },
    { id: "refactor", label: "Refactor" },
    { id: "review", label: "Review" },
    { id: "commit", label: "Commit" }
  ];

  // ------------------------------------------------------------- messaging

  function post(message) {
    vscode.postMessage(message);
  }

  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (!msg || !msg.type) {
      return;
    }
    switch (msg.type) {
      case "init":
        applyConfig(msg.config);
        applyConversation(msg.conversation);
        break;
      case "setConfig":
        applyConfig(msg.config);
        break;
      case "render":
        applyConversation(msg.conversation);
        break;
      case "streamStart":
        startStream(msg.message);
        break;
      case "streamDelta":
        pushDelta(msg.messageId, msg.text);
        break;
      case "streamEnd":
        endStream(msg.message);
        break;
      case "streamCancelled":
        endStream(null, msg.messageId);
        break;
      case "error":
        showStreamError(msg.messageId, msg.text);
        break;
      case "busy":
        setBusy(msg.busy);
        break;
      case "showNotice":
        notify(msg.level, msg.message);
        break;
      case "setStatus":
        applyStatus(msg.status);
        break;
      case "composer":
        el.input.value = msg.text || "";
        autoGrow();
        if (msg.mode) {
          el.mode.value = msg.mode;
        }
        if (msg.mentions && msg.mentions.length) {
          state.mentions = msg.mentions.slice();
        }
        renderMentions();
        el.input.focus();
        break;
      case "mentionResults":
        state.popover.items = msg.files;
        state.popover.kind = "file";
        state.popover.index = 0;
        if (state.popover.items.length) {
          openPopover();
        } else {
          closePopover();
        }
        renderPopover();
        break;
    }
  });

  // ----------------------------------------------------------------- state

  function applyConfig(config) {
    if (!config) {
      return;
    }
    state.config = config;

    const current = el.model.value;
    el.model.innerHTML = "";
    for (const model of config.models) {
      const option = document.createElement("option");
      option.value = model.id;
      option.textContent = model.label;
      option.title = model.hint;
      el.model.appendChild(option);
    }
    if (config.models.some((m) => m.id === config.model)) {
      el.model.value = config.model;
    } else {
      const option = document.createElement("option");
      option.value = config.model;
      option.textContent = config.model;
      el.model.appendChild(option);
      el.model.value = config.model;
    }
    el.model.value = current && config.models.some((m) => m.id === current) ? current : config.model;
    el.mode.value = config.mode;
    renderHint();
  }

  function applyStatus(status) {
    if (!status) {
      return;
    }
    state.status = status;
    el.statusDot.className = "nr-dot" + (status.hasKey ? (status.copilotLimited ? " warn" : "") : " off");
    el.subLine.textContent = `${status.provider} · ${status.model}${
      status.copilotLimited ? " · Copilot out of tokens" : ""
    }${config2().workspaceTrusted ? "" : " · untrusted workspace"}`;
    renderHint();
  }

  function config2() {
    return state.config || { workspaceTrusted: true, contextChars: 0, includeCurrentFile: true };
  }

  function applyConversation(conversation) {
    state.conversation = conversation || { id: "", title: "", createdAt: 0, updatedAt: 0, messages: [] };
    state.streamingId = null;
    state.streamText = "";
    renderAll();
  }

  function setBusy(busy) {
    state.busy = busy;
    el.stop.hidden = !busy;
    el.send.hidden = busy;
    el.send.disabled = busy;
    for (const chip of el.quickbar.children) {
      chip.classList.toggle("busy", busy);
    }
  }

  // --------------------------------------------------------------- render

  function renderAll() {
    const messages = state.conversation.messages;
    el.messages.innerHTML = "";

    if (!messages.length) {
      const empty = document.createElement("div");
      empty.className = "nr-empty";
      empty.innerHTML =
        "<div><strong>NightRider</strong></div>" +
        "<div>Ask about the file you are editing,</div>" +
        "<div>type <code>@</code> to attach a file,</div>" +
        "<div>or pick an action above.</div>";
      el.messages.appendChild(empty);
      updateHintVisibility();
      return;
    }

    for (const message of messages) {
      el.messages.appendChild(buildMessage(message));
    }
    updateHintVisibility();
    scrollToBottom(true);
  }

  function buildMessage(message) {
    const wrap = document.createElement("div");
    wrap.className = "nr-msg " + message.role;
    wrap.dataset.id = message.id;

    const head = document.createElement("div");
    head.className = "nr-msg-head";

    const role = document.createElement("span");
    role.className = "nr-role";
    role.textContent = message.role === "user" ? "You" : "NightRider";
    head.appendChild(role);

    if (message.model) {
      const model = document.createElement("span");
      model.textContent = message.model;
      head.appendChild(model);
    }

    const time = document.createElement("span");
    time.textContent = new Date(message.createdAt).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit"
    });
    head.appendChild(time);

    const tools = document.createElement("div");
    tools.className = "nr-msg-tools";
    head.appendChild(tools);

    wrap.appendChild(head);

    if (message.mentions && message.mentions.length) {
      const files = document.createElement("div");
      files.className = "nr-files";
      for (const path of message.mentions) {
        const chip = document.createElement("button");
        chip.className = "nr-file";
        chip.textContent = path;
        chip.title = `Open ${path}`;
        chip.addEventListener("click", () => post({ type: "openFile", path }));
        files.appendChild(chip);
      }
      wrap.appendChild(files);
    }

    const body = document.createElement("div");
    body.className = "nr-body";
    wrap.appendChild(body);

    if (message.error) {
      const error = document.createElement("div");
      error.className = "nr-error";
      error.textContent = message.error;
      body.appendChild(error);
    } else {
      body.innerHTML = MD.render(message.content);
    }

    buildTools(tools, message);
    return wrap;
  }

  function buildTools(tools, message) {
    const isLast = state.conversation.messages[state.conversation.messages.length - 1] === message;

    const copy = mini("copy", "Copy", () => {
      vscode.postMessage({ type: "codeAction", action: "copy", code: message.content, language: "" });
    });
    tools.appendChild(copy);

    if (message.role === "user") {
      tools.appendChild(
        mini("edit", "Edit and resend", () => startEdit(message))
      );
    }

    if (message.role === "assistant" && isLast) {
      tools.appendChild(
        mini("refresh", "Regenerate", () => post({ type: "regenerate" }))
      );
    }

    if (message.role === "assistant" && !message.error) {
      const up = mini("thumbs-up", "Helpful", () => {
        post({ type: "feedback", messageId: message.id, value: "up" });
        up.classList.toggle("on");
      });
      const down = mini("thumbs-down", "Not helpful", () => {
        post({ type: "feedback", messageId: message.id, value: "down" });
        down.classList.toggle("on");
      });
      tools.appendChild(up);
      tools.appendChild(down);
    }

    tools.appendChild(
      mini("trash", "Delete message", () => post({ type: "deleteMessage", id: message.id }))
    );
  }

  function mini(icon, title, onClick) {
    const button = document.createElement("button");
    button.className = "nr-mini";
    button.textContent = glyph(icon);
    button.title = title;
    button.addEventListener("click", onClick);
    return button;
  }

  const GLYPHS = {
    copy: "⧉",
    edit: "✎",
    refresh: "↻",
    "thumbs-up": "▲",
    "thumbs-down": "▼",
    trash: "✕"
  };
  const glyph = (name) => GLYPHS[name] || "•";

  // ------------------------------------------------------------ streaming

  let renderQueued = false;

  function startStream(message) {
    state.streamingId = message.id;
    state.streamText = "";

    const wrap = buildMessage({ ...message, content: "" });
    const body = wrap.querySelector(".nr-body");
    const caret = document.createElement("span");
    caret.className = "nr-caret";
    body.appendChild(caret);

    el.messages.appendChild(wrap);
    updateHintVisibility();
    scrollToBottom(true);
    requestRender(message.id, body, caret);
  }

  function pushDelta(messageId, text) {
    if (state.streamingId !== messageId) {
      return;
    }
    state.streamText += text;
    scheduleRender();
  }

  function scheduleRender() {
    if (renderQueued) {
      return;
    }
    renderQueued = true;
    setTimeout(() => {
      renderQueued = false;
      renderStream();
    }, 90);
  }

  function renderStream() {
    if (!state.streamingId) {
      return;
    }
    const wrap = el.messages.querySelector(`[data-id="${state.streamingId}"]`);
    if (!wrap) {
      return;
    }
    const body = wrap.querySelector(".nr-body");
    if (!body) {
      return;
    }
    const caret = body.querySelector(".nr-caret");
    const atBottom = isAtBottom();
    body.innerHTML = MD.render(state.streamText);
    if (caret) {
      body.appendChild(caret);
    }
    if (atBottom) {
      scrollToBottom(false);
    }
  }

  function requestRender(id, body, caret) {
    state.streamingId = id;
    state.streamText = "";
    const run = () => {
      body.innerHTML = MD.render(state.streamText);
      if (caret) {
        body.appendChild(caret);
      }
      scrollToBottom(false);
    };
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(run);
    } else {
      run();
    }
  }

  function endStream(message, cancelledId) {
    const id = message ? message.id : cancelledId;
    const wrap = id ? el.messages.querySelector(`[data-id="${id}"]`) : null;
    if (wrap) {
      wrap.remove();
    }
    state.streamingId = null;
    state.streamText = "";

    if (message) {
      const index = state.conversation.messages.findIndex((m) => m.id === message.id);
      if (index === -1) {
        state.conversation.messages.push(message);
      } else {
        state.conversation.messages[index] = message;
      }
    }
    renderAll();
  }

  function showStreamError(messageId, text) {
    const wrap = el.messages.querySelector(`[data-id="${messageId}"]`);
    state.streamingId = null;
    state.streamText = "";

    if (wrap) {
      const body = wrap.querySelector(".nr-body");
      body.innerHTML = "";
      const error = document.createElement("div");
      error.className = "nr-error";
      error.textContent = text;
      body.appendChild(error);
      const tools = wrap.querySelector(".nr-msg-tools");
      tools.innerHTML = "";
      tools.appendChild(
        mini("refresh", "Try again", () => post({ type: "regenerate" }))
      );
      tools.appendChild(
        mini("trash", "Delete message", () => post({ type: "deleteMessage", id: messageId }))
      );
      tools.appendChild(
        mini("copy", "Copy error", () =>
          post({ type: "codeAction", action: "copy", code: text, language: "" })
        )
      );
    }
    notify("error", text);
    scrollToBottom(false);
  }

  // -------------------------------------------------------------- editing

  function startEdit(message) {
    el.input.value = message.content;
    state.mentions = (message.mentions || []).slice();
    renderMentions();
    autoGrow();
    el.input.focus();
    el.input.dataset.editId = message.id;
    el.hint.textContent = "Enter to resend this edit and drop everything after it.";
  }

  // -------------------------------------------------------------- composer

  el.input.addEventListener("input", () => {
    autoGrow();
    syncState();
    detectMention();
    renderHint();
  });

  el.input.addEventListener("keydown", (event) => {
    if (state.popover.open) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        moveSelection(1);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        moveSelection(-1);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        acceptPopover();
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        closePopover();
        return;
      }
    }

    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  });

  el.input.addEventListener("blur", () => {
    setTimeout(() => {
      if (!state.popover.open) {
        closePopover();
      }
    }, 150);
  });

  el.send.addEventListener("click", submit);
  el.stop.addEventListener("click", () => post({ type: "stop" }));

  el.mode.addEventListener("change", () => {
    post({ type: "setMode", mode: el.mode.value });
    el.input.focus();
  });

  el.model.addEventListener("change", () => {
    post({ type: "setModel", id: el.model.value });
    el.input.focus();
  });

  el.statusBtn.addEventListener("click", () => {
    if (state.popover.open && state.popover.kind === "status") {
      closePopover();
      return;
    }
    const s = state.status || {};
    state.popover.items = [
      { label: "Switch from Copilot to NightRider", action: "nightrider.copilot.switch" },
      { label: "Copilot tokens refreshed", action: "nightrider.copilot.clearLimit" },
      { label: "Set API key", action: "nightrider.key.set" },
      { label: "Select model", action: "nightrider.model.select" },
      { label: "Chat history", action: "nightrider.chat.history" },
      { label: "New chat", action: "nightrider.chat.newChat" },
      { label: "Open settings", action: "nightrider.config.open" }
    ];
    state.popover.kind = "status";
    state.popover.index = 0;
    openPopover();
    state.popover.header =
      `${s.provider || ""} · ${s.model || ""}\n` +
      `Copilot: ${s.copilotInstalled ? (s.copilotSignedIn ? "signed in" : "installed") : "not detected"}` +
      (s.copilotLimited ? " · out of tokens" : "");
    renderPopover();
  });

  el.popover.addEventListener("mousedown", (event) => {
    const item = event.target.closest(".nr-pop-item");
    if (!item) {
      return;
    }
    event.preventDefault();
    state.popover.index = Number(item.dataset.index);
    acceptPopover();
  });

  function submit() {
    if (state.busy) {
      return;
    }
    const text = el.input.value.trim();
    if (!text) {
      return;
    }
    const editId = el.input.dataset.editId;
    const mentions = state.mentions.slice();
    const mode = el.mode.value;

    el.input.value = "";
    el.input.dataset.editId = "";
    state.mentions = [];
    renderMentions();
    autoGrow();
    closePopover();

    if (editId) {
      post({ type: "editMessage", id: editId, text });
    } else {
      post({ type: "send", text, mode, mentions });
    }
    syncState();
    el.input.focus();
  }

  function autoGrow() {
    el.input.style.height = "auto";
    el.input.style.height = Math.min(el.input.scrollHeight, 180) + "px";
  }

  function syncState() {
    vscode.setState({
      draft: el.input.value,
      mentions: state.mentions,
      mode: el.mode.value
    });
  }

  // -------------------------------------------------------------- mentions

  function detectMention() {
    const caret = el.input.selectionStart ?? 0;
    const before = el.input.value.slice(0, caret);
    const match = before.match(/(^|\s)@([^\s@]*)$/);
    if (!match) {
      closePopover();
      return;
    }
    state.mention = { start: caret - match[2].length - 1, query: match[2] };
    post({ type: "mentionQuery", query: match[2] });
  }

  function acceptPopover() {
    const item = state.popover.items[state.popover.index];
    if (!item) {
      return;
    }
    if (state.popover.kind === "file" && state.mention) {
      const caret = el.input.selectionStart ?? 0;
      const before = el.input.value.slice(0, state.mention.start);
      const after = el.input.value.slice(caret);
      el.input.value = `${before}@${item.name} ${after}`;
      const cursor = before.length + item.name.length + 2;
      el.input.setSelectionRange(cursor, cursor);
      if (!state.mentions.includes(item.path)) {
        state.mentions.push(item.path);
      }
      renderMentions();
      autoGrow();
      el.input.focus();
    } else if (state.popover.kind === "status" && item.action) {
      post({ type: "command", id: item.action });
    }
    closePopover();
  }

  function openPopover() {
    state.popover.open = true;
    el.popover.hidden = false;
    positionPopover();
    renderPopover();
  }

  function closePopover() {
    state.popover.open = false;
    state.popover.items = [];
    state.popover.kind = null;
    state.mention = null;
    el.popover.hidden = true;
  }

  function positionPopover() {
    const rect = el.input.getBoundingClientRect();
    el.popover.style.left = Math.max(6, rect.left) + "px";
    el.popover.style.bottom = (window.innerHeight - rect.top + 6) + "px";
    el.popover.style.maxWidth = Math.max(180, rect.width) + "px";
  }

  function moveSelection(delta) {
    const count = state.popover.items.length;
    if (!count) {
      return;
    }
    state.popover.index = (state.popover.index + delta + count) % count;
    renderPopover();
  }

  function renderPopover() {
    el.popover.innerHTML = "";
    if (state.popover.header) {
      const head = document.createElement("div");
      head.className = "nr-pop-sep";
      head.textContent = state.popover.header;
      el.popover.appendChild(head);
    }
    state.popover.items.forEach((item, index) => {
      const row = document.createElement("div");
      row.className = "nr-pop-item" + (index === state.popover.index ? " sel" : "");
      row.dataset.index = String(index);
      row.textContent = item.path || item.label;
      row.title = item.path || item.label;
      el.popover.appendChild(row);
    });
    positionPopover();
  }

  function renderMentions() {
    el.mentionBar.innerHTML = "";
    el.mentionBar.hidden = state.mentions.length === 0;
    for (const path of state.mentions) {
      const chip = document.createElement("span");
      chip.className = "nr-mention";
      const label = document.createElement("span");
      label.textContent = path;
      const close = document.createElement("button");
      close.textContent = "✕";
      close.title = `Remove ${path}`;
      close.addEventListener("click", () => {
        state.mentions = state.mentions.filter((p) => p !== path);
        renderMentions();
        syncState();
      });
      chip.appendChild(label);
      chip.appendChild(close);
      el.mentionBar.appendChild(chip);
    }
  }

  // ----------------------------------------------------------- code blocks

  el.messages.addEventListener("click", (event) => {
    const button = event.target.closest(".nr-code-btn");
    if (!button) {
      return;
    }
    const block = button.closest(".nr-code");
    const code = block.querySelector("code").textContent;
    const language = block.dataset.lang || "";
    post({ type: "codeAction", action: button.dataset.action, code, language });
  });

  // --------------------------------------------------------- quick actions

  for (const action of QUICK_ACTIONS) {
    const chip = document.createElement("button");
    chip.className = "nr-chip";
    chip.textContent = action.label;
    chip.title = `NightRider: ${action.label}`;
    chip.addEventListener("click", () => post({ type: "runQuickAction", action: action.id }));
    el.quickbar.appendChild(chip);
  }

  // ---------------------------------------------------------------- chrome

  el.messages.addEventListener("scroll", () => {
    state.stickToBottom = isAtBottom();
  });

  function isAtBottom() {
    const node = el.messages;
    return node.scrollHeight - node.scrollTop - node.clientHeight < 40;
  }

  function scrollToBottom(force) {
    if (!force && !state.stickToBottom) {
      return;
    }
    el.messages.scrollTop = el.messages.scrollHeight;
  }

  function notify(level, message) {
    el.notice.hidden = false;
    el.notice.className = "nr-notice " + level;
    el.notice.textContent = message;
    clearTimeout(state.noticeTimer);
    state.noticeTimer = setTimeout(() => {
      el.notice.hidden = true;
    }, level === "error" ? 12000 : 6000);
  }

  function renderHint() {
    if (state.streamingId) {
      el.hint.textContent = "Generating… press Stop to cancel.";
      return;
    }
    const cfg = config2();
    const parts = ["Enter sends · Shift+Enter for a newline · @ attaches a file"];
    if (state.mentions.length) {
      parts.unshift(`${state.mentions.length} file${state.mentions.length === 1 ? "" : "s"} attached`);
    }
    if (cfg.workspaceTrusted === false) {
      parts.push("workspace untrusted: editing and terminal are disabled");
    }
    el.hint.textContent = parts.join(" · ");
  }

  function updateHintVisibility() {
    renderHint();
  }

  window.addEventListener("resize", () => {
    if (state.popover.open) {
      positionPopover();
    }
  });

  // ------------------------------------------------------------------ boot

  (function restore() {
    const saved = vscode.getState();
    if (saved && saved.draft) {
      el.input.value = saved.draft;
      state.mentions = saved.mentions || [];
      renderMentions();
      autoGrow();
    }
    if (saved && saved.mode) {
      el.mode.value = saved.mode;
    }
    el.hint.textContent = "Enter sends · Shift+Enter for a newline · @ attaches a file";
    post({ type: "ready" });
  })();
})();
