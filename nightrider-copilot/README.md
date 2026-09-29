# NightRider — AI coding assistant for VS Code

A Copilot-style assistant with streaming chat, real workspace context, inline
editor actions, and a one-command handoff from GitHub Copilot.

## Install

```bash
npm install
npx vsce package --no-git-tag-version
code --install-extension nightrider-copilot-2.0.0.vsix
```

Then set your model key:

- `NightRider: Set API Key` (stored in VS Code SecretStorage, not settings)

The key is stored in SecretStorage, so it is never written into
`settings.json` and never shared with a webview.

The default provider is Groq's OpenAI-compatible endpoint. Any OpenAI-compatible
base URL works: set `nightrider.apiBaseUrl` and `nightrider.model`.

## Features

**Chat**
- Streaming responses with a live caret, stop button, and per-message actions
- Code fences get syntax highlighting, Copy, and Apply / Insert / Preview
- Shell fences get Run, with confirmation before anything executes
- Conversation history: new, switch, rename, delete, clear
- Regenerate, edit-and-resend, and delete any message

**Context** — automatically attached, in priority order:
1. Your selection
2. The active file
3. Files you `@`-mention
4. Other open tabs
5. Files matching your question

Budgeted by `nightrider.maxFileContextChars` so large repos stay fast.

**Editor**
- Lightbulb code actions: Explain, Fix, Optimize, Document, Generate Tests
- Commands for the active file or the current selection
- Apply replaces the selection, Insert places at the caret, Preview opens a diff
- Undo, split, and move accepted edits through the native undo stack

**Native chat**
- `/nightrider` in the Chat view, with `explain`, `fix`, `test`, `docs`, `review`
- `NightRider: Ask` and `NightRider: Ask About Selection`

**Copilot handoff**
- `NightRider: Switch from Copilot` carries the active file and selection over
- `NightRider: Copilot: Report Limit` and `...: Clear Limit` if you want manual control
- A status bar item shows provider and state

## Commands

| Command | What it does |
| --- | --- |
| `Open Chat` | Reveal the sidebar |
| `New Chat` | Start a conversation |
| `Ask NightRider` | Prefill the composer with the active file |
| `Ask About Selection` | Scope the question to the selection |
| `Edit Last Message` | Edit and resend your last question |
| `Chat History` | Switch, rename, or delete a conversation |
| `Explain This File` | Walk through the current file |
| `Fix Errors in This File` | Fix the file |
| `Write Tests for This File` | Generate tests |
| `Document This File` | Add or improve docs |
| `Refactor This File` | Refactor the file |
| `Review This File` | Review for bugs |
| `Fix Problems in Workspace` | Fix every visible diagnostic |
| `Copy Code Block` | Copy the last code block |
| `Apply Code to File` | Replace the selection, or the whole file |
| `Insert Code at Cursor` | Insert at the caret without touching the selection |
| `Preview Changes` | Open a side-by-side diff before applying |
| `Run Command in Terminal` | Run the last shell block |
| `Switch from Copilot to NightRider` | Import the current context |
| `I Ran Out of Copilot Tokens` | Flag the limit reached |
| `Copilot Tokens Refreshed` | Clear the limit flag |
| `Show Copilot & NightRider Status` | Provider and state summary |
| `Set API Key` / `Clear API Key` | Manage the stored key |
| `Select Model` | Pick a model |
| `Open Settings` | Jump to NightRider settings |

## Settings

| Setting | Default | Notes |
| --- | --- | --- |
| `nightrider.apiBaseUrl` | `https://api.groq.com/openai/v1` | Any OpenAI-compatible endpoint |
| `nightrider.model` | `openai/gpt-oss-120b` | Must exist at your provider; see the [Groq model list](https://console.groq.com/docs/models) |
| `nightrider.temperature` | `0.2` | |
| `nightrider.maxOutputTokens` | `4096` | |
| `nightrider.streaming` | `true` | Turn off to get one final message |
| `nightrider.includeCurrentFile` | `true` | |
| `nightrider.includeSelection` | `true` | |
| `nightrider.maxContextFiles` | `6` | |
| `nightrider.maxFileContextChars` | `40000` | Hard cap on attached code |
| `nightrider.autoContext` | `true` | Infer files from your question |
| `nightrider.confirmBeforeApply` | `true` | |
| `nightrider.confirmBeforeRun` | `true` | |
| `nightrider.saveHistory` | `true` | Off keeps history in memory only |
| `nightrider.maxSavedConversations` | `25` | |
| `nightrider.copilot.statusBar` | `true` | |
| `nightrider.copilot.autoHandoff` | `false` | See the note below |
| `nightrider.copilot.handoffContext` | `true` | Carry file/selection across |
| `nightrider.systemPrompt` | `""` | Extra instructions for every request |
| `nightrider.telemetryNotice` | `true` | First-run disclosure |

## Copilot handoff: what is and isn't possible

VS Code does not expose GitHub Copilot's remaining quota to extensions. There is
no supported API that answers "how many tokens are left", so NightRider cannot
detect the limit on its own. Rather than guess, it gives you two honest options:

- **Manual:** `NightRider: Copilot: Report Limit` sets a "limit reached" state
  that tints the status bar, then `NightRider: Switch from Copilot` moves your
  active file and selection across.
- **Assisted:** `nightrider.copilot.autoHandoff` opens NightRider with the
  current context queued whenever you run the switch command while the state is
  flagged.

The assistant, context engine, and editor actions are all first-party. Semantic
indexing, inline ghost-text completion, and Copilot's quota telemetry are not
Copilot's private implementation and are not reproduced here.

## Privacy and safety

- The API key lives in VS Code SecretStorage and is only read host-side.
- Prompts and attached code go to the provider you configured. Nothing else.
- Webviews run with a strict CSP, no inline scripts, and no network access.
- Model output is escaped before rendering, and `javascript:` URLs are rejected.
- Nothing is written to disk, run in a terminal, or inserted into a file
  without confirmation.
- In an untrusted workspace no file contents are read or sent; edits and
  terminal commands stay blocked.

## Development

```bash
npm run compile     # tsc -> out/
npm run watch       # incremental
npm run check       # type-check only
npm test            # 166 assertions, runs the compiled output
```

Press <kbd>F5</kbd> to launch an Extension Development Host.

### Tests

`test/` drives the compiled extension in `out/` against a stubbed `vscode`
module, so it exercises the same code the VSIX ships.

| File | Covers |
| --- | --- |
| `test/client.test.cjs` | Streaming, retries, cancellation, error classification |
| `test/activate.test.cjs` | Activation, every manifest command, CSP and disposal |
| `test/e2e.test.cjs` | Webview to host to LLM to webview against a fake provider |
| `test/webview.test.cjs` | The real generated HTML in jsdom: streaming, XSS, mentions |
| `test/logic.test.cjs` | History store, file ranking, context budget, prompts |
| `test/regress.test.cjs` | Untrusted workspaces and `saveHistory: false` |

Add cases as plain `check(name, condition, detail)` calls in any
`*.test.cjs`; `test/run.cjs` picks them up automatically.

Layout:

```
src/
  extension.ts       activation, commands, provider wiring
  config.ts          typed settings
  history.ts         conversation store
  secrets.ts         SecretStorage wrapper
  llm/               streaming client, prompts, model catalog
  context/           file index, ranking, context budget
  editor/            code actions, apply/insert/preview
  copilot/           detection and handoff state
  views/             chat webview, chat participant, status bar
media/               webview assets (no framework, no build step)
```
