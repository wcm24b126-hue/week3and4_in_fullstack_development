import * as vscode from "vscode";
import type { KnightRiderConfig } from "../config";
import { logWarn } from "../logging";
import type { AttachedFile, ContextBundle } from "../types";
import { getFileIndex, rankFiles, type IndexedFile } from "./fileIndex";

const textDocSelectors = [
  { scheme: "file" },
  { scheme: "untitled" },
  { scheme: "vscode-vfs" },
  { scheme: "vscode-remote" }
];

export interface ContextRequest {
  mentions: string[];
  query: string;
  includeSelection: boolean;
  config: KnightRiderConfig;
}

export async function buildContext(req: ContextRequest): Promise<ContextBundle> {
  const cfg = req.config;
  const files: AttachedFile[] = [];
  const sections: string[] = [];
  let truncated = false;

  const budget = Math.max(2000, cfg.maxFileContextChars);
  let used = 0;
  const spend = (n: number): boolean => {
    if (used + n > budget) {
      truncated = true;
      return false;
    }
    used += n;
    return true;
  };

  // In an untrusted workspace the manifest promises that no file contents or
  // workspace listings leave the machine, so short-circuit before reading
  // anything off disk. An untrusted user still gets a working assistant, it
  // just answers from the prompt alone.
  if (!vscode.workspace.isTrusted) {
    logWarn("untrusted workspace: skipping all file context");
    return {
      text: "",
      files: [],
      truncated: false,
      symbols: "",
      diagnostics: ""
    };
  }

  // 1. Selection is the highest signal, so it goes first.
  const editor = vscode.window.activeTextEditor;
  if (editor && cfg.includeSelection && !editor.selection.isEmpty) {
    const text = editor.document.getText(editor.selection);
    if (text.trim()) {
      const rel = describe(editor.document.uri);
      const clipped = clip(text, 8000);
      if (spend(clipped.length)) {
        sections.push(
          `Selected code from ${rel} (lines ${editor.selection.start.line + 1}-${editor.selection.end.line + 1}):\n${clipped}`
        );
      }
    }
  }

  // 2. Explicitly @-mentioned files.
  // The index is only worth building if something can actually consume it, so
  // an un-mentioned, auto-context-disabled request never pays for the scan.
  const wantMentions = req.mentions.length > 0;
  const wantAuto = cfg.autoContext && !wantMentions && req.query.trim().length > 0;
  const index = wantMentions || wantAuto ? await getFileIndex() : undefined;
  const mentioned: IndexedFile[] = [];
  if (index) {
    for (const rel of req.mentions.slice(0, cfg.maxContextFiles)) {
      const file = await resolveMention(rel, index);
      if (file) {
        mentioned.push(file);
      }
    }
  }

  for (const file of mentioned) {
    const text = await readBoundedText(file.uri, 12000);
    if (text === undefined) {
      continue;
    }
    const clipped = text.text;
    if (!spend(clipped.length)) {
      break;
    }
    files.push({
      path: file.relPath,
      name: file.name,
      chars: text.totalChars,
      truncated: text.truncated
    });
    sections.push(`File: ${file.relPath}\n${clipped}`);
  }

  // 3. The file the developer is currently editing.
  if (cfg.includeCurrentFile && editor && isText(editor.document)) {
    const rel = describe(editor.document.uri);
    const already = mentioned.some((m) => m.relPath === rel);
    if (!already && !rel.startsWith("Untitled")) {
      const text = editor.document.getText();
      const clipped = clip(text, 12000);
      if (spend(clipped.length)) {
        files.unshift({ path: rel, name: rel.split(/[\\/]/).pop() ?? rel, chars: text.length, truncated: text.length !== clipped.length });
        sections.push(`Currently open file: ${rel}\n${clipped}`);
      }
    }
  }

  // 4. Otherwise search for the files the question is about.
  if (wantAuto && index) {
    const ranked = rankFiles(index, req.query, Math.min(3, cfg.maxContextFiles));
    for (const file of ranked) {
      if (mentioned.some((m) => m.relPath === file.relPath)) {
        continue;
      }
      if (editor && describe(editor.document.uri) === file.relPath) {
        continue;
      }
      const text = await readBoundedText(file.uri, 8000);
      if (text === undefined) {
        continue;
      }
      const clipped = text.text;
      if (!spend(clipped.length)) {
        break;
      }
      files.push({
        path: file.relPath,
        name: file.name,
        chars: text.totalChars,
        truncated: text.truncated
      });
      sections.push(`Related file: ${file.relPath}\n${clipped}`);
    }
  }

  const symbols = editor && isText(editor.document) ? await describeSymbols(editor.document) : "";
  // Scoped to the active document. The unscoped call returns every diagnostic
  // in the window, which is what used to stall the extension host on request.
  const diagnostics = editor ? collectDiagnostics(editor.document.uri) : "";

  return {
    text: sections.join("\n\n"),
    files,
    truncated,
    symbols,
    diagnostics
  };
}

async function resolveMention(rel: string, index: { byRelPath: Map<string, IndexedFile>; all: IndexedFile[] }): Promise<IndexedFile | undefined> {
  const direct = index.byRelPath.get(rel.toLowerCase());
  if (direct) {
    return direct;
  }
  const suffix = index.all.find((f) => f.relPath.toLowerCase().endsWith("/" + rel.toLowerCase()) || f.name.toLowerCase() === rel.toLowerCase());
  if (suffix) {
    return suffix;
  }
  // Last resort: treat it as a real path.
  const uri = vscode.Uri.file(rel.replace(/^\/+/, ""));
  try {
    const stat = await vscode.workspace.fs.stat(uri);
    if (stat.type === vscode.FileType.File) {
      const relPath = vscode.workspace.asRelativePath(uri, false);
      const name = rel.split(/[\\/]/).pop() ?? rel;
      return { uri, relPath, name, relLower: relPath.toLowerCase(), nameLower: name.toLowerCase() };
    }
  } catch {
    /* not a path */
  }
  return undefined;
}

/**
 * Files larger than this are never read for context. Without a cap a single
 * minified bundle or lock file would be materialised as a multi-megabyte
 * string just to keep its first few thousand characters.
 */
const MAX_CONTEXT_FILE_BYTES = 512 * 1024;

interface BoundedText {
  /** The (possibly clipped) text to attach to the prompt. */
  text: string;
  /** True-length of the file on disk, for the UI. */
  totalChars: number;
  truncated: boolean;
}

/**
 * Reads a file for context without going through `openTextDocument`.
 *
 * `openTextDocument` registers a real document model that is never released,
 * so every mention leaked one for the life of the window. `workspace.fs` reads
 * the bytes directly and leaves no model behind. Oversized files are skipped
 * outright rather than read and thrown away.
 */
async function readBoundedText(
  uri: vscode.Uri,
  max: number
): Promise<BoundedText | undefined> {
  const scheme = uri.scheme;
  if (scheme !== "file" && scheme !== "vscode-remote" && scheme !== "vscode-vfs") {
    return undefined;
  }
  try {
    const stat = await vscode.workspace.fs.stat(uri);
    if (stat.type !== vscode.FileType.File) {
      return undefined;
    }
    if (stat.size > MAX_CONTEXT_FILE_BYTES) {
      logWarn(`skipping oversized context file (${stat.size} bytes): ${uri.fsPath}`);
      return undefined;
    }
    const bytes = await vscode.workspace.fs.readFile(uri);
    const decoded = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    // Strip a BOM and any NUL padding so binary-ish files are not attached.
    if (decoded.includes("\u0000")) {
      return undefined;
    }
    const text = decoded.charCodeAt(0) === 0xfeff ? decoded.slice(1) : decoded;
    return {
      text: clip(text, max),
      totalChars: text.length,
      truncated: text.length > max
    };
  } catch {
    return undefined;
  }
}

function isText(doc: vscode.TextDocument): boolean {
  return textDocSelectors.some((s) => s.scheme === doc.uri.scheme) && doc.languageId !== "gitcommit";
}

export function describe(uri: vscode.Uri): string {
  return vscode.workspace.asRelativePath(uri, false);
}

async function describeSymbols(doc: vscode.TextDocument): Promise<string> {
  try {
    const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
      "vscode.executeDocumentSymbolProvider",
      doc.uri
    );
    if (!symbols?.length) {
      return "";
    }
    const lines: string[] = [];
    const walk = (list: vscode.DocumentSymbol[], depth: number): void => {
      for (const s of list) {
        lines.push(`${"  ".repeat(depth)}${s.kind === vscode.SymbolKind.Class ? "class" : s.kind === vscode.SymbolKind.Function || s.kind === vscode.SymbolKind.Method ? "fn" : s.kind === vscode.SymbolKind.Interface ? "interface" : s.kind === vscode.SymbolKind.TypeParameter ? "type" : "sym"} ${s.name} (line ${s.range.start.line + 1})`);
        if (s.children?.length) {
          walk(s.children, depth + 1);
        }
      }
    };
    walk(symbols, 0);
    return lines.slice(0, 120).join("\n");
  } catch {
    return "";
  }
}

function collectDiagnostics(uri: vscode.Uri): string {
  try {
    if (uri.scheme === "output" || uri.scheme === "git") {
      return "";
    }
    // Scoped call: only the file the developer is actually looking at.
    const all = vscode.languages.getDiagnostics(uri);
    const lines: string[] = [];
    const rel = describe(uri);
    for (const d of all) {
      if (d.severity === vscode.DiagnosticSeverity.Hint || d.severity === vscode.DiagnosticSeverity.Information) {
        continue;
      }
      const sev = d.severity === vscode.DiagnosticSeverity.Error ? "error" : "warning";
      const code = typeof d.code === "object" && d.code ? ` (${(d.code as { value: string | number }).value})` : d.code ? ` (${d.code})` : "";
      lines.push(`${rel}:${d.range.start.line + 1}:${d.range.start.character + 1} ${sev}${code}: ${d.message.replace(/\s+/g, " ")}`);
      if (lines.length >= 20) {
        return lines.join("\n");
      }
    }
    return lines.join("\n");
  } catch (err) {
    logWarn("failed to read diagnostics", err);
    return "";
  }
}

export function clip(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  const head = Math.floor(max * 0.65);
  const tail = max - head;
  const omitted = text.length - max;
  return `${text.slice(0, head)}\n/* ... ${omitted} characters omitted ... */\n${text.slice(text.length - tail)}`;
}
