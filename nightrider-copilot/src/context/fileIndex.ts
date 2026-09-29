import * as vscode from "vscode";
import { logWarn } from "../logging";

const IGNORE_GLOB = "**/{node_modules,.git,dist,out,build,.next,coverage,vendor,target,.venv,__pycache__,bin,obj}/**";

export interface IndexedFile {
  uri: vscode.Uri;
  relPath: string;
  name: string;
}

export interface FileIndex {
  all: IndexedFile[];
  byRelPath: Map<string, IndexedFile>;
  stale: boolean;
  updatedAt: number;
}

let cache: FileIndex | undefined;
let inflight: Promise<FileIndex> | undefined;

export function invalidateFileIndex(): void {
  cache = undefined;
  inflight = undefined;
}

/** Throwing away the cache on every keystroke would be wasteful, so a TTL is used. */
const CACHE_TTL_MS = 15000;

export async function getFileIndex(): Promise<FileIndex> {
  if (cache && !cache.stale && Date.now() - cache.updatedAt < CACHE_TTL_MS) {
    return cache;
  }
  if (inflight) {
    return inflight;
  }

  inflight = (async (): Promise<FileIndex> => {
    try {
      const uris = await vscode.workspace.findFiles(IGNORE_GLOB, "**/.vscode/**", 4000);
      const all: IndexedFile[] = [];
      const byRelPath = new Map<string, IndexedFile>();

      for (const uri of uris) {
        const folder = vscode.workspace.getWorkspaceFolder(uri);
        const relPath = folder
          ? vscode.workspace.asRelativePath(uri, false)
          : uri.fsPath;
        const file: IndexedFile = {
          uri,
          relPath,
          name: relPath.split(/[\\/]/).pop() ?? relPath
        };
        all.push(file);
        byRelPath.set(relPath.toLowerCase(), file);
      }

      all.sort((a, b) => a.relPath.localeCompare(b.relPath));
      cache = { all, byRelPath, stale: false, updatedAt: Date.now() };
      return cache;
    } catch (err) {
      logWarn("failed to build file index", err);
      cache = { all: [], byRelPath: new Map(), stale: true, updatedAt: Date.now() };
      return cache;
    } finally {
      inflight = undefined;
    }
  })();

  return inflight;
}

interface Scored {
  file: IndexedFile;
  score: number;
}

const CODE_EXT = /\.[a-z0-9]+$/i;

/**
 * Cheap lexical ranking. Not an embedding search, but it reliably surfaces the
 * files a developer means when they name a symbol, a path fragment or an import.
 */
export function rankFiles(index: FileIndex, query: string, limit: number): IndexedFile[] {
  const terms = tokenize(query);
  if (terms.length === 0) {
    return [];
  }

  const scored: Scored[] = [];
  for (const file of index.all) {
    const hay = file.relPath.toLowerCase();
    let score = 0;
    let matched = false;

    for (const term of terms) {
      if (hay.includes(term)) {
        matched = true;
        score += 6;
        if (file.name.toLowerCase() === term) {
          score += 10;
        } else if (file.name.toLowerCase().includes(term)) {
          score += 4;
        }
        if (hay.endsWith(term)) {
          score += 3;
        }
      }
    }

    // The extension is only a tiebreaker, it must never qualify a file on its
    // own or every query would return every source file.
    if (!matched) {
      continue;
    }
    if (/\.(ts|tsx|js|jsx|mjs|cjs|mts|cts|py|go|rs|java|rb|php|cs|c|h|cc|cpp|hpp|kt|swift|scala|sql|sh|bash|zsh|json|ya?ml|toml|html|css|scss|vue|svelte|astro|graphql|proto|dockerfile|makefile)$/i.test(file.relPath)) {
      score += 1;
    }

    scored.push({ file, score });
  }

  scored.sort((a, b) => b.score - a.score || a.file.relPath.length - b.file.relPath.length);
  return scored.slice(0, limit).map((s) => s.file);
}

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_$./\\-]+/)
    .map((t) => t.replace(/^[._/\\-]+/, ""))
    .filter((t) => t.length >= 2 && !CODE_EXT.test(t));
}

export function findByRelPath(index: FileIndex, relPath: string): IndexedFile | undefined {
  return (
    index.byRelPath.get(relPath.toLowerCase()) ??
    index.byRelPath.get(relPath.replace(/^\.\//, "").toLowerCase())
  );
}
