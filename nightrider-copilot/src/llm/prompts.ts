import type { Mode } from "../config";
import type { ContextBundle } from "../types";

const BASE =
  "You are KnightRider, an expert pair programmer embedded in Visual Studio Code. " +
  "You are precise, direct, and technically accurate.\n" +
  "Rules you always follow:\n" +
  "1. Prefer the smallest correct change. Do not rewrite working code that was not asked about.\n" +
  "2. When you propose code, wrap it in a single fenced code block tagged with its language " +
  "(for example ```ts). Never wrap prose in a code block.\n" +
  "3. Wrap any shell command in a ```bash fenced block and nothing else.\n" +
  "4. Do not invent APIs. If you are unsure about a library's exact signature, say so.\n" +
  "5. Keep explanations short. Lead with the answer, then the reasoning.\n" +
  "6. Respect the language and code style already present in the provided context.\n" +
  "7. Never repeat the file back to the user in full.\n";

const MODE_INSTRUCTIONS: Record<Mode, string> = {
  chat:
    "Answer the developer's question. If the answer is a concrete edit, produce the complete " +
    "edited snippet in one code block, not a diff narrative.",
  analyze:
    "Analyse the provided workspace context. Start with what the project does, then the request " +
    "answer. Reference concrete file paths. Keep it structured and skimmable.",
  terminal:
    "The developer wants a command line solution. Produce one ```bash block with a runnable command. " +
    "Add a one-line note on what it does. Do not produce multiple alternative commands.",
  fix:
    "Find the defect and fix it. State the root cause in one sentence, then give the corrected code " +
    "in a single fenced block. Include a line or two on how to verify the fix."
};

export function systemPrompt(mode: Mode, context: ContextBundle, extra: string): string {
  const parts = [BASE, MODE_INSTRUCTIONS[mode]];
  if (context.text.trim()) {
    parts.push("Context provided by the editor:\n" + context.text.trim());
  }
  if (context.symbols.trim()) {
    parts.push("Symbols in the active file:\n" + context.symbols.trim());
  }
  if (context.diagnostics.trim()) {
    parts.push("Current problems reported by the language server:\n" + context.diagnostics.trim());
  }
  if (extra.trim()) {
    parts.push("Additional user instructions for this session:\n" + extra.trim());
  }
  return parts.join("\n\n");
}

export const QUICK_ACTIONS = {
  explain: {
    label: "Explain",
    prompt:
      "Explain what this code does. Cover the intent, the control flow, and any non-obvious " +
      "decisions. Call out anything that looks like a bug or a trap for the next maintainer."
  },
  fix: {
    label: "Fix",
    prompt:
      "Find the bugs in this code and fix them. For each problem give the cause and the fix. " +
      "Return the complete corrected code in a single fenced block."
  },
  tests: {
    label: "Tests",
    prompt:
      "Write unit tests for this code using the testing framework already present in the project. " +
      "Cover the happy path, the edge cases, and the failure cases. Match the existing test style."
  },
  document: {
    label: "Document",
    prompt:
      "Add documentation to this code: a file-level summary comment, doc comments for every " +
      "exported symbol, and brief inline comments only where the intent is not obvious. " +
      "Return the complete updated code in a single fenced block."
  },
  refactor: {
    label: "Refactor",
    prompt:
      "Refactor this code for clarity without changing its behaviour. Remove dead code, " +
      "unify duplicated logic, and improve naming. Return the complete updated code in a single " +
      "fenced block."
  },
  review: {
    label: "Review",
    prompt:
      "Review this code. Report correctness bugs, security issues, performance traps, and " +
      "missing error handling. For each finding give the severity, the location, and the fix. " +
      "Do not report style preferences."
  },
  commit: {
    label: "Commit message",
    prompt:
      "Write a conventional-commit message for these changes. Output a single fenced ```bash " +
      "block containing the git commit command with a quoted subject line and a body."
  }
} as const;

export const HANDOFF_PROMPT =
  "I was working on this in GitHub Copilot and ran out of tokens. Here is where I got to - " +
  "review it, tell me what is still missing, and continue the work.";
