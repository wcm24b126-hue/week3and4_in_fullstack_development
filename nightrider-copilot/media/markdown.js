/*
 * Minimal CommonMark-ish renderer.
 *
 * Everything is escaped up front and only tags this file creates are emitted,
 * so untrusted model output cannot inject markup. Code blocks are returned as
 * placeholders and filled in afterwards with highlighted, escaped HTML.
 */
(function (global) {
  "use strict";

  const HL = global.KnightRiderHighlight;
  const escapeHtml = HL ? HL.escapeHtml : (t) =>
    String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  const SAFE_SCHEME = /^(https?:|mailto:|#|\/|\.\/|\.\.\/)/i;

  function safeUrl(url) {
    const trimmed = String(url || "").trim();
    if (!trimmed) {
      return null;
    }
    if (SAFE_SCHEME.test(trimmed)) {
      return escapeHtml(trimmed);
    }
    // Reject javascript:, data:, vbscript: and anything else unexpected.
    return /^[\w.+-]+:/.test(trimmed) ? null : escapeHtml(trimmed);
  }

  // ---------------------------------------------------------------- inline

  function inline(text) {
    const codes = [];
    let src = escapeHtml(text);

    // Protect code spans first so nothing inside them is reformatted.
    src = src.replace(/(`+)([\s\S]*?)\1/g, (_, ticks, body) => {
      codes.push(body.replace(/^ | $/g, ""));
      return `\u0000C${codes.length - 1}\u0000`;
    });

    // Images before links, because the syntax overlaps.
    src = src.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (m, alt, url) => {
      const href = safeUrl(url);
      return href ? `<img src="${href}" alt="${alt}" loading="lazy">` : alt;
    });

    src = src.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (m, label, url) => {
      const href = safeUrl(url);
      return href
        ? `<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>`
        : label;
    });

    src = src.replace(/(^|[\s(])((?:https?:\/\/)[^\s<>()]+[^\s<>().,;:!?'"])/g,
      (_, lead, url) => {
        const href = safeUrl(url);
        return href ? `${lead}<a href="${href}" target="_blank" rel="noopener noreferrer">${url}</a>` : `${lead}${url}`;
      });

    src = src.replace(/~~([\s\S]+?)~~/g, "<del>$1</del>");
    src = src.replace(/\*\*\*([^*]+)\*\*\*/g, "<strong><em>$1</em></strong>");
    src = src.replace(/\*\*([\s\S]+?)\*\*/g, "<strong>$1</strong>");
    src = src.replace(/__([\s\S]+?)__/g, "<strong>$1</strong>");
    src = src.replace(/(^|[^*\w])\*([^*\n][\s\S]*?)\*(?!\*)/g, "$1<em>$2</em>");
    src = src.replace(/(^|[^_\w])_([^_\n][\s\S]*?)_(?!_)/g, "$1<em>$2</em>");

    src = src.replace(/\u0000C(\d+)\u0000/g, (_, i) => `<code class="inline">${codes[Number(i)]}</code>`);

    return src;
  }

  // ----------------------------------------------------------------- block

  function listMarker(line) {
    const bullet = line.match(/^(\s*)([-*+])\s+(.*)$/);
    if (bullet) {
      return { indent: bullet[1].length, ordered: false, content: bullet[3] };
    }
    const ordered = line.match(/^(\s*)(\d+)[.)]\s+(.*)$/);
    if (ordered) {
      return { indent: ordered[1].length, ordered: true, content: ordered[3], start: Number(ordered[2]) };
    }
    return null;
  }

  function isTableDivider(line) {
    return /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/.test(line) && line.includes("-");
  }

  function splitRow(line) {
    return line
      .replace(/^\s*\|/, "")
      .replace(/\|\s*$/, "")
      .split("|")
      .map((c) => c.trim());
  }

  function render(markdown) {
    const lines = String(markdown || "").replace(/\r\n?/g, "\n").split("\n");
    const blocks = [];
    const codes = [];
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];

      // fenced code
      const fence = line.match(/^\s*(```+|~~~+)\s*([A-Za-z0-9+#._-]*)\s*$/);
      if (fence) {
        const marker = fence[1][0];
        const lang = fence[2] || "";
        const body = [];
        const closes = new RegExp(`^\\s*\\${marker}{3,}\\s*$`);
        i++;
        while (i < lines.length && !closes.test(lines[i])) {
          body.push(lines[i]);
          i++;
        }
        i++;
        codes.push({ code: body.join("\n"), lang });
        blocks.push(`\u0000K${codes.length - 1}\u0000`);
        continue;
      }

      // blank
      if (!line.trim()) {
        i++;
        continue;
      }

      // horizontal rule
      if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) {
        blocks.push("<hr>");
        i++;
        continue;
      }

      // heading
      const heading = line.match(/^(#{1,6})\s+(.*)$/);
      if (heading) {
        const level = heading[1].length;
        blocks.push(`<h${level}>${inline(heading[2].trim())}</h${level}>`);
        i++;
        continue;
      }

      // table
      if (line.includes("|") && i + 1 < lines.length && isTableDivider(lines[i + 1])) {
        const header = splitRow(line);
        const rows = [];
        i += 2;
        while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
          rows.push(splitRow(lines[i]));
          i++;
        }
        const head = header.map((c) => `<th>${inline(c)}</th>`).join("");
        const body = rows
          .map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`)
          .join("");
        blocks.push(`<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`);
        continue;
      }

      // blockquote
      if (/^\s*>\s?/.test(line)) {
        const quoted = [];
        while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
          quoted.push(lines[i].replace(/^\s*>\s?/, ""));
          i++;
        }
        blocks.push(`<blockquote>${render(quoted.join("\n"))}</blockquote>`);
        continue;
      }

      // list
      const marker = listMarker(line);
      if (marker) {
        const baseIndent = marker.indent;
        const items = [];
        let current = null;
        while (i < lines.length) {
          const m = listMarker(lines[i]);
          if (m && m.indent <= baseIndent + 1) {
            if (m.indent < baseIndent) {
              break;
            }
            // Switching bullet style starts a separate list, otherwise the
            // second list gets swallowed into the first one.
            if (current && m.ordered !== items[0].ordered) {
              break;
            }
            current = { lines: [m.content], ordered: m.ordered, start: m.start };
            items.push(current);
            i++;
            continue;
          }
          if (!lines[i].trim()) {
            const next = lines[i + 1];
            if (next && (listMarker(next) || /^\s{2,}\S/.test(next))) {
              if (current) {
                current.lines.push("");
              }
              i++;
              continue;
            }
            break;
          }
          if (current) {
            current.lines.push(lines[i].replace(new RegExp(`^\\s{0,${baseIndent + 2}}`), ""));
          }
          i++;
        }
        blocks.push(renderItems(items));
        continue;
      }

      // paragraph
      const para = [];
      while (i < lines.length && lines[i].trim() && !listMarker(lines[i]) && !/^\s*(#{1,6})\s/.test(lines[i]) &&
             !/^\s*(```+|~~~+)/.test(lines[i]) && !/^\s*>\s?/.test(lines[i])) {
        para.push(lines[i]);
        i++;
      }
      if (para.length) {
        const text = para.join("\n");
        const html = inline(text).replace(/\n/g, "<br>\n");
        blocks.push(`<p>${html}</p>`);
      }
    }


    let html = blocks.join("");
    html = html.replace(/\u0000K(\d+)\u0000/g, (_, index) => renderCode(codes[Number(index)]));
    return html;
  }

  function renderItems(items) {
    if (!items.length) {
      return "";
    }
    const ordered = items[0].ordered;
    const startAttr = ordered && items[0].start && items[0].start !== 1 ? ` start="${items[0].start}"` : "";
    const tag = ordered ? "ol" : "ul";
    const body = items
      .map((item) => {
        const bodyHtml = render(item.lines.join("\n"));
        // Unwrap only a lone paragraph; anything with a nested list or block
        // must stay block level or the markup becomes <p> inside <p>.
        const lone = /^<p>[\s\S]*<\/p>$/.exec(bodyHtml);
        const inner = lone ? bodyHtml.slice(3, -4) : bodyHtml;
        const hasBlock = /<(?:ul|ol|blockquote|pre|table|hr|h[1-6])\b/.test(inner);
        return `<li>${hasBlock ? inner : `<p>${inner}</p>`}</li>`;
      })
      .join("");
    return `<${tag}${startAttr}>${body}</${tag}>`;
  }

  function renderCode(block) {
    const lang = block.lang || "";
    const code = block.code || "";
    const highlighted = HL ? HL.highlight(code, lang) : escapeHtml(code);
    const name = (lang || "text").toLowerCase();
    const isShell = ["bash", "sh", "shell", "console", "zsh", "fish", "powershell", "ps1", "bat"].includes(name);
    return (
      `<div class="nr-code" data-lang="${escapeHtml(lang)}">` +
      `<div class="nr-code-head">` +
      `<span class="nr-code-lang">${escapeHtml(lang || "text")}</span>` +
      `<button class="nr-code-btn" data-action="copy" title="Copy code">Copy</button>` +
      (isShell
        ? `<button class="nr-code-btn" data-action="run" title="Run in terminal">Run</button>`
        : `<button class="nr-code-btn" data-action="insert" title="Insert at cursor">Insert</button>` +
          `<button class="nr-code-btn" data-action="apply" title="Replace the file or selection">Apply</button>` +
          `<button class="nr-code-btn" data-action="preview" title="Show a diff first">Diff</button>`) +
      `</div><pre><code>${highlighted}</code></pre></div>`
    );
  }

  global.KnightRiderMarkdown = { render, inline, escapeHtml };
})(typeof globalThis !== "undefined" ? globalThis : this);
