import * as vscode from "vscode";
import type { NightRiderConfig } from "../config";
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
  config: NightRiderConfig;
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
  const index = await getFileIndex();
  const mentioned: IndexedFile[] = [];
  for (const rel of req.mentions.slice(0, cfg.maxContextFiles)) {
    const file = await resolveMention(rel, index);
    if (file) {
      mentioned.push(file);
    }
  }

  for (const file of mentioned) {
    const doc = await openTextDocument(file.uri);
    if (!doc) {
      continue;
    }
    const text = doc.getText();
    const clipped = clip(text, 12000);
    if (!spend(clipped.length)) {
      break;
    }
    files.push({
      path: file.relPath,
      name: file.name,
      chars: text.length,
      truncated: text.length !== clipped.length
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
  if (cfg.autoContext && mentioned.length === 0 && req.query.trim()) {
    const ranked = rankFiles(index, req.query, Math.min(3, cfg.maxContextFiles));
    for (const file of ranked) {
      if (mentioned.some((m) => m.relPath === file.relPath)) {
        continue;
      }
      if (editor && describe(editor.document.uri) === file.relPath) {
        continue;
      }
      const doc = await openTextDocument(file.uri);
      if (!doc) {
        continue;
      }
      const text = doc.getText();
      const clipped = clip(text, 8000);
      if (!spend(clipped.length)) {
        break;
      }
      files.push({
        path: file.relPath,
        name: file.name,
        chars: text.length,
        truncated: text.length !== clipped.length
      });
      sections.push(`Related file: ${file.relPath}\n${clipped}`);
    }
  }

  const symbols = editor && isText(editor.document) ? await describeSymbols(editor.document) : "";
  const diagnostics = collectDiagnostics();

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
      return { uri, relPath: vscode.workspace.asRelativePath(uri, false), name: rel.split(/[\\/]/).pop() ?? rel };
    }
  } catch {
    /* not a path */
  }
  return undefined;
}

async function openTextDocument(uri: vscode.Uri): Promise<vscode.TextDocument | undefined> {
  const scheme = uri.scheme;
  const allowed = scheme === "file" || scheme === "untitled" || scheme === "vscode-remote" || scheme === "vscode-vfs";
  if (!allowed) {
    return undefined;
  }
  try {
    const doc = await vscode.workspace.openTextDocument(uri);
    if (doc.languageId === "git" || doc.uri.scheme === "git") {
      return undefined;
    }
    return doc;
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

function collectDiagnostics(): string {
  try {
    const all = vscode.languages.getDiagnostics();
    const lines: string[] = [];
    for (const [uri, diags] of all) {
      if (uri.scheme === "output" || uri.scheme === "git") {
        continue;
      }
      for (const d of diags) {
        if (d.severity === vscode.DiagnosticSeverity.Hint || d.severity === vscode.DiagnosticSeverity.Information) {
          continue;
        }
        const sev = d.severity === vscode.DiagnosticSeverity.Error ? "error" : "warning";
        const rel = describe(uri);
        const code = typeof d.code === "object" && d.code ? ` (${(d.code as { value: string | number }).value})` : d.code ? ` (${d.code})` : "";
        lines.push(`${rel}:${d.range.start.line + 1}:${d.range.start.character + 1} ${sev}${code}: ${d.message.replace(/\s+/g, " ")}`);
        if (lines.length >= 40) {
          return lines.join("\n");
        }
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
