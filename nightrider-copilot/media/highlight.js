/*
 * Small dependency-free syntax highlighter.
 *
 * Rules are separate regexes and the earliest match wins, with comments taking
 * the tie. That avoids the classic failure of a single alternation regex, where
 * a `//` inside a string is read as a comment, or a quote inside a comment is
 * read as a string. Everything is escaped before it is wrapped in markup, so
 * model output can never inject HTML.
 */
(function (global) {
  "use strict";

  const KEYWORDS = {
    js: "as async await break case catch class const continue debugger default delete do else export extends finally for from function get if implements import in instanceof interface let new of package private protected public return set static super switch this throw try typeof var void while with yield",
    ts: "abstract any as asserts async await bigint boolean break case catch class const constructor continue declare default delete do else enum export extends finally for from function get if implements import in infer instanceof interface is keyof let module namespace never new number object of private protected public readonly return satisfies set static string super switch symbol this throw try type typeof undefined unique unknown var void while yield",
    py: "and as assert async await break class continue def del elif else except finally for from global if import in is lambda match nonlocal not or pass raise return try while with yield True False None self",
    rb: "alias and begin break case class def defined do else elsif end ensure for if in module next nil not or redo rescue retry return self super then undef unless until when while yield attr_accessor attr_reader attr_writer private protected public",
    go: "break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var",
    rs: "as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while",
    java: "abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for if implements import instanceof int interface long native new package private protected public return short static super switch synchronized this throw throws transient try void volatile while true false null var record sealed permits yield",
    c: "auto break case char const continue default do double else enum extern float for goto if inline int long register restrict return short signed sizeof static struct switch typedef union unsigned void volatile while",
    cpp: "alignas alignof and asm auto bool break case catch char class concept const consteval constexpr constinit const_cast continue co_await co_return co_yield decltype default delete do double dynamic_cast else enum explicit export extern false float for friend goto if inline int long mutable namespace new noexcept nullptr operator or private protected public register reinterpret_cast requires return short signed sizeof static static_assert static_cast struct switch template this thread_local throw true try typedef typeid typename union unsigned using virtual void volatile wchar_t while",
    php: "abstract and array as break callable case catch class clone const continue declare default do echo else elseif empty enddeclare endwhile enum extends final finally fn for foreach function global goto if implements include include_once instanceof insteadof interface isset list match namespace new or print private protected public readonly require require_once return static switch throw trait try unset use var while xor yield",
    sh: "if then else elif fi case esac for while until do done in function select time coproc break continue return local export readonly declare unset shift source alias set trap",
    sql: "select from where group by having order limit offset join inner left right outer full cross on as and or not in exists between like is null distinct union all insert into values update set delete create table alter drop index view with recursive case when then else end",
    yaml: "",
    json: "",
    html: "",
    css: "",
    md: ""
  };

  const BUILTINS = {
    js: "console window document Math JSON Object Array String Number Boolean Promise Map Set WeakMap WeakSet Symbol Date RegExp Error Reflect Proxy BigInt globalThis undefined NaN Infinity process require module exports",
    ts: "string number boolean any unknown never void object symbol bigint Array Promise Record Partial Readonly Pick Omit Exclude Extract ReturnType Parameters Awaited",
    py: "print len range enumerate zip map filter sorted sum min max abs open input int float str list dict set tuple isinstance getattr setattr hasattr super Exception ValueError TypeError KeyError IndexError",
    rb: "puts print p require nil",
    go: "fmt err nil true false string int int64 error len make new append copy panic recover",
    rs: "Some None Ok Err Option Result Vec String Box bool i32 i64 u32 u64 usize isize println vec format",
    java: "System String Integer Boolean List ArrayList Map HashMap Object Math Exception Override void",
    c: "printf scanf malloc free NULL FILE",
    cpp: "std cout cin endl vector string map set unique_ptr shared_ptr nullptr printf",
    php: "echo print count array_map array_filter var_dump isset unset",
    sh: "cd ls cat grep sed awk curl git npm node python pip docker make sudo rm cp mv mkdir echo",
    sql: "count sum avg min max coalesce cast now current_timestamp",
    json: "true false null",
    html: "",
    css: "",
    md: ""
  };

  const HASH_COMMENT = { sh: true, py: true, rb: true, yaml: true, toml: true, ini: true, r: true, makefile: true, dockerfile: true, perl: true, perl6: true, nim: true, elixir: true };

  const ALIASES = {
    javascript: "js", jsx: "js", mjs: "js", cjs: "js",
    typescript: "ts", tsx: "ts", mts: "ts", cts: "ts",
    python: "py", python3: "py", py3: "py",
    ruby: "rb", golang: "go", rust: "rs",
    "c++": "cpp", cxx: "cpp", cc: "cpp", hpp: "cpp", hxx: "cpp",
    c: "c", h: "c",
    kt: "java", kotlin: "java", cs: "java", csharp: "java",
    sh: "sh", bash: "sh", zsh: "sh", shell: "sh", console: "sh",
    powershell: "sh", ps1: "sh", fish: "sh", bat: "sh", batch: "sh",
    yml: "yaml", toml: "yaml", ini: "yaml", cfg: "yaml", conf: "yaml",
    dockerfile: "sh", makefile: "sh", mk: "sh",
    jsonc: "json", json5: "json", jsonl: "json",
    xml: "html", svg: "html", vue: "html", svelte: "html", htm: "html",
    scss: "css", sass: "css", less: "css",
    plaintext: "text", txt: "text", text: "text",
    md: "md", markdown: "md"
  };

  function normalize(lang) {
    const key = String(lang || "").toLowerCase().trim();
    if (!key) {
      return "text";
    }
    const mapped = ALIASES[key];
    if (mapped) {
      return mapped;
    }
    return KEYWORDS[key] !== undefined ? key : "text";
  }

  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  const TOKEN = {
    comment: "comment",
    string: "string",
    number: "number",
    keyword: "keyword",
    builtin: "builtin",
    tag: "tag",
    attr: "attr",
    prop: "prop",
    ident: "ident"
  };

  function buildRules(lang) {
    const keywords = new Set((KEYWORDS[lang] || "").split(/\s+/).filter(Boolean));
    const builtins = new Set((BUILTINS[lang] || "").split(/\s+/).filter(Boolean));
    const hash = !!HASH_COMMENT[lang];

    const rules = [];

    if (lang === "html") {
      rules.push({ re: /<!--[\s\S]*?-->/g, kind: TOKEN.comment });
      rules.push({ re: /<\/?[A-Za-z][\w:-]*/g, kind: TOKEN.tag });
      rules.push({ re: /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, kind: TOKEN.attr });
      rules.push({ re: /[A-Za-z_:][\w:.-]*(?==)/g, kind: TOKEN.attr });
      rules.push({ re: /\/?>/g, kind: TOKEN.tag });
      return rules;
    }

    if (lang === "css") {
      rules.push({ re: /\/\*[\s\S]*?\*\//g, kind: TOKEN.comment });
      rules.push({ re: /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, kind: TOKEN.string });
      rules.push({ re: /@[\w-]+/g, kind: TOKEN.keyword });
      rules.push({ re: /--[\w-]+/g, kind: TOKEN.prop });
      rules.push({ re: /#[\da-fA-F]{3,8}\b/g, kind: TOKEN.number });
      rules.push({ re: /-?\d*\.?\d+(?:px|rem|em|vh|vw|%|s|ms|deg|fr)?\b/g, kind: TOKEN.number });
      rules.push({ re: /[.#][\w-]+/g, kind: TOKEN.tag });
      rules.push({ re: /[a-zA-Z-]+(?=\s*:)/g, kind: TOKEN.prop });
      rules.push({ re: /[a-zA-Z-]+/g, kind: TOKEN.ident });
      return rules;
    }

    if (lang === "json") {
      rules.push({ re: /"(?:[^"\\]|\\.)*"(?=\s*:)/g, kind: TOKEN.prop });
      rules.push({ re: /"(?:[^"\\]|\\.)*"/g, kind: TOKEN.string });
      rules.push({ re: /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g, kind: TOKEN.number });
      rules.push({ re: /\b(?:true|false|null)\b/g, kind: TOKEN.keyword });
      return rules;
    }

    if (lang === "sql") {
      rules.push({ re: /--[^\n]*/g, kind: TOKEN.comment });
      rules.push({ re: /\/\*[\s\S]*?\*\//g, kind: TOKEN.comment });
      rules.push({ re: /'(?:[^']|'')*'/g, kind: TOKEN.string });
      rules.push({ re: /"(?:[^"]|"")*"/g, kind: TOKEN.string });
      rules.push({ re: /\b\d+(?:\.\d+)?\b/g, kind: TOKEN.number });
      rules.push({ re: /[A-Za-z_][\w$]*/g, kind: (t) => (keywords.has(t.toLowerCase()) ? TOKEN.keyword : TOKEN.ident) });
      return rules;
    }

    // Comments first so they win ties against strings.
    if (hash) {
      rules.push({ re: /#[^\n]*/g, kind: TOKEN.comment });
    } else {
      rules.push({ re: /\/\*[\s\S]*?\*\//g, kind: TOKEN.comment });
      rules.push({ re: /\/\/[^\n]*/g, kind: TOKEN.comment });
    }

    rules.push({ re: /"""[\s\S]*?"""/g, kind: TOKEN.string });
    rules.push({ re: /'''[\s\S]*?'''/g, kind: TOKEN.string });
    rules.push({ re: /`(?:\\[\s\S]|[^`\\])*`/g, kind: TOKEN.string });
    rules.push({ re: /"(?:\\[\s\S]|[^"\\\n])*"/g, kind: TOKEN.string });
    rules.push({ re: /'(?:\\[\s\S]|[^'\\\n])*'/g, kind: TOKEN.string });
    rules.push({ re: /\b0[xXbBoO][0-9a-fA-F_]+n?\b/g, kind: TOKEN.number });
    rules.push({ re: /\b\d[\d_]*(?:\.[\d_]+)?(?:[eE][+-]?\d+)?\b/g, kind: TOKEN.number });
    rules.push({
      re: /[A-Za-z_$][\w$]*/g,
      kind: (t) => (keywords.has(t) ? TOKEN.keyword : builtins.has(t) ? TOKEN.builtin : TOKEN.ident)
    });
    rules.push({ re: /[{}()[\];,.]/g, kind: TOKEN.ident });

    return rules;
  }

  const compiled = new Map();
  function compile(lang) {
    if (!compiled.has(lang)) {
      compiled.set(lang, buildRules(lang));
    }
    return compiled.get(lang).map((r) => ({ ...r, re: new RegExp(r.re.source, r.re.flags) }));
  }

  /**
   * @param {string} code
   * @param {string} lang
   * @returns {string} HTML
   */
  function highlight(code, lang) {
    const normalized = normalize(lang);
    if (normalized === "text" || normalized === "md") {
      return escapeHtml(code);
    }

    const rules = compile(normalized);
    const length = code.length;
    const state = rules.map((r) => {
      r.re.lastIndex = 0;
      return { rule: r, match: r.re.exec(code) };
    });

    let out = "";
    let last = 0;
    let guard = 0;

    while (guard++ < 200000) {
      let best = null;
      for (const s of state) {
        // A cached match that starts before the cursor already lost, or is
        // stale, so re-run that rule from the cursor.
        if (s.match && s.match.index < last) {
          s.rule.re.lastIndex = last;
          s.match = s.rule.re.exec(code);
          if (s.match) {
            s.rule.re.lastIndex = s.match.index;
          }
        }
        if (!s.match) {
          continue;
        }
        if (!best || s.match.index < best.match.index) {
          best = s;
        }
      }

      if (!best || best.match.index >= length) {
        break;
      }

      const token = best.match[0];
      if (token.length === 0) {
        best.rule.re.lastIndex = best.match.index + 1;
        best.match = best.rule.re.exec(code);
        continue;
      }

      if (best.match.index > last) {
        out += escapeHtml(code.slice(last, best.match.index));
      }

      const kind = typeof best.rule.kind === "function" ? best.rule.kind(token) : best.rule.kind;
      out += kind ? `<span class="tok-${kind}">${escapeHtml(token)}</span>` : escapeHtml(token);

      last = best.match.index + token.length;
      best.rule.re.lastIndex = last;
      best.match = best.rule.re.exec(code);
    }

    out += escapeHtml(code.slice(last));
    return out;
  }

  global.NightRiderHighlight = { highlight, escapeHtml, normalize };
})(typeof globalThis !== "undefined" ? globalThis : this);
