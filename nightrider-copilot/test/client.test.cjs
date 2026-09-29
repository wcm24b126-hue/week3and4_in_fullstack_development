const { check, report } = require("./harness.cjs");
const http = require("http");
const path = require("path");
const OUT = path.join(require("./harness.cjs").OUT, "llm", "client.js");
const { complete, LlmError } = require(OUT);

let hits = 0;
const server = http.createServer((req, res) => {
  hits++;
  const auth = req.headers.authorization;

  if (auth === "Bearer key-401") { res.writeHead(401, {"content-type":"application/json"}); return res.end(JSON.stringify({error:{message:"Invalid API Key"}})); }
  if (auth === "Bearer key-429") {
    if (hits < 3) { res.writeHead(429, {"content-type":"application/json"}); return res.end(JSON.stringify({error:{message:"Rate limit reached"}})); }
    res.writeHead(200, {"content-type":"application/json"}); return res.end(JSON.stringify({choices:[{message:{content:"recovered"}}]}));
  }
  if (auth === "Bearer key-500") { res.writeHead(503, {"content-type":"text/plain"}); return res.end("upstream down"); }
  if (auth === "Bearer key-404") { res.writeHead(404, {"content-type":"application/json"}); return res.end(JSON.stringify({error:{message:"model not found"}})); }
  if (auth === "Bearer key-empty") { res.writeHead(200,{"content-type":"application/json"}); return res.end(JSON.stringify({choices:[{message:{content:"  "}}]})); }
  if (auth === "Bearer key-404err") { res.writeHead(200,{"content-type":"application/json"}); return res.end(JSON.stringify({error:{message:"bad model"}})); }

  // streaming, chunked weirdly including splitting mid-line and mid-\n\n
  res.writeHead(200, {"content-type":"text/event-stream"});
  const events = [
    'data: {"model":"m-1","choices":[{"delta":{"content":"Hello"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":", wor"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"ld!"}}]}\n\n',
    ': a comment line\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":11,"completion_tokens":5}}\n\n',
    'data: [DONE]\n\n'
  ].join("");
  let i = 0;
  const t = setInterval(() => {
    if (i >= events.length) { clearInterval(t); return res.end(); }
    const chunk = events.slice(i, i += 9);
    res.write(chunk);
  }, 5);
});

const base = () => `http://127.0.0.1:${server.address().port}/v1`;

function req(key, extra = {}) {
  return { baseUrl: base(), apiKey: key, model: "m", messages: [{role:"user",content:"hi"}], temperature: 0.2, maxTokens: 100, stream: false, ...extra };
}

(async () => {
  await new Promise(r => server.listen(0, r));

  // 1. non-streaming
  hits = 0;
  let r = await complete(req("key-429"));
  check("non-streaming after 429 retries", r.text === "recovered" && hits === 3, `hits=${hits} text=${r.text}`);

  // 2. streaming
  const deltas = [];
  r = await complete(req("ok", { stream: true, onDelta: (d) => deltas.push(d) }));
  check("streaming text", r.text === "Hello, world!", `got "${r.text}"`);
  check("streaming deltas joined", deltas.join("") === r.text, `deltas=${JSON.stringify(deltas)}`);
  check("streaming model name", r.model === "m-1", r.model);
  check("streaming usage", r.promptTokens === 11 && r.completionTokens === 5, JSON.stringify(r));
  check("streaming finish reason", r.finishReason === "stop", r.finishReason);

  // 3. 401 -> auth
  try { await complete(req("key-401")); check("401 auth", false); }
  catch (e) { check("401 auth", e instanceof LlmError && e.kind === "auth" && e.status === 401, `${e.kind} ${e.status}`); }

  // 4. 404 -> server kind with helpful message
  try { await complete(req("key-404")); check("404", false); }
  catch (e) { check("404 message mentions model/endpoint", e.kind === "server" && /nightrider\.model/.test(e.message), e.message); }

  // 5. 500 -> retries then server error
  hits = 0;
  try { await complete(req("key-500")); check("500", false); }
  catch (e) { check("500 retried 4x then server error", e.kind === "server" && hits === 4, `kind=${e.kind} hits=${hits}`); }

  // 6. empty -> empty kind
  try { await complete(req("key-empty")); check("empty", false); }
  catch (e) { check("empty response kind", e.kind === "empty", e.kind); }

  // 7. error inside SSE
  try { await complete(req("key-404err", { stream: true })); check("sse error", false); }
  catch (e) { check("error inside SSE stream", e.kind === "server" && e.message === "bad model", `${e.kind} ${e.message}`); }

  // 8. abort
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 30);
  try { await complete(req("ok", { stream: true, signal: ac.signal })); check("abort", false); }
  catch (e) { check("abort yields aborted kind", e.kind === "aborted", e.kind); }

  // 9. network error
  try { await complete({ ...req("ok"), baseUrl: "http://127.0.0.1:1/v1", signal: undefined }); check("net", false); }
  catch (e) { check("unreachable host -> network kind", e.kind === "network", e.kind); }

  // 10. non-json error body
  hits = 0;
  try { await complete({ ...req("ok"), baseUrl: base().replace("/v1", "/v1") , apiKey: "key-500" }); } catch {}

  server.close();
  process.exit(report("suite"));
})();
