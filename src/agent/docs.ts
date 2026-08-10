/**
 * The HTML rendering of /docs.
 *
 * Deliberately self-contained: no CDN script, no external stylesheet, no web
 * font. A documentation page that an agent cannot render without fetching four
 * other origins is a poor documentation page, and every extra host is another
 * entry the Phase 2 CSP would have to allow.
 *
 * docs.md is the source of truth for the content; this is a hand-maintained
 * mirror of it. Keep them in step.
 */
import { ORIGIN } from "./config";

const STYLE = `
:root { color-scheme: light dark; --fg:#16161d; --muted:#5b5b6b; --bg:#fff;
        --surface:#f6f6f9; --border:#e2e2ea; --accent:#4b3ff5; }
@media (prefers-color-scheme: dark) {
  :root { --fg:#e8e8f2; --muted:#a0a0b8; --bg:#0b0b14; --surface:#15151f;
          --border:#26263a; --accent:#8b83ff; }
}
* { box-sizing:border-box; }
body { margin:0; padding:2.5rem 1.25rem 5rem; background:var(--bg); color:var(--fg);
       font:16px/1.65 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif; }
main { max-width:52rem; margin:0 auto; }
h1 { font-size:2rem; letter-spacing:-.02em; margin:0 0 .25rem; }
h2 { font-size:1.25rem; letter-spacing:-.01em; margin:2.75rem 0 .75rem;
     padding-top:1.25rem; border-top:1px solid var(--border); }
h3 { font-size:1rem; margin:1.75rem 0 .5rem; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; }
p, li { color:var(--fg); }
.lede { color:var(--muted); font-size:1.05rem; margin:0 0 2rem; }
a { color:var(--accent); }
code { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:.9em;
       background:var(--surface); border:1px solid var(--border); border-radius:4px;
       padding:.1em .35em; }
pre { background:var(--surface); border:1px solid var(--border); border-radius:8px;
      padding:1rem; overflow-x:auto; }
pre code { background:none; border:none; padding:0; }
table { border-collapse:collapse; width:100%; margin:1rem 0; display:block; overflow-x:auto; }
th, td { text-align:left; padding:.55rem .75rem; border-bottom:1px solid var(--border);
         vertical-align:top; }
th { font-size:.8rem; text-transform:uppercase; letter-spacing:.06em; color:var(--muted); }
footer { margin-top:3.5rem; padding-top:1.25rem; border-top:1px solid var(--border);
         color:var(--muted); font-size:.9rem; }
`.trim();

export const DOCS_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>EleenAI API Documentation</title>
<meta name="description" content="HTTP API reference for EleenAI: chat, image generation, vision and web-search-grounded answers.">
<link rel="canonical" href="${ORIGIN}/docs">
<link rel="alternate" type="text/markdown" href="${ORIGIN}/docs.md">
<link rel="service-desc" type="application/json" href="${ORIGIN}/api/v1/openapi.json">
<style>${STYLE}</style>
</head>
<body>
<main>
<h1>EleenAI API</h1>
<p class="lede">Streaming chat, image generation, vision, and web-search-grounded
answers with citations. The machine-readable description of everything here is at
<a href="/api/v1/openapi.json">/api/v1/openapi.json</a>.</p>

<table>
<tr><th>Base URL</th><td><code>${ORIGIN}</code></td></tr>
<tr><th>Catalog</th><td><a href="/.well-known/api-catalog">/.well-known/api-catalog</a></td></tr>
<tr><th>Health</th><td><a href="/api/v1/health">/api/v1/health</a></td></tr>
<tr><th>Auth</th><td><a href="/auth.md">/auth.md</a></td></tr>
<tr><th>MCP</th><td><code>${ORIGIN}/mcp</code></td></tr>
<tr><th>Markdown</th><td><a href="/docs.md">/docs.md</a></td></tr>
</table>

<h2>Tiers</h2>
<p>Most capabilities are reachable two ways. Tokens are issued by the authorization
server named in <a href="/.well-known/oauth-protected-resource">the protected resource
metadata</a> &mdash; EleenAI does not issue them itself.</p>
<table>
<tr><th></th><th>Guest</th><th>Authenticated</th></tr>
<tr><td>Path</td><td><code>/api/&hellip;/guest</code></td><td><code>/api/&hellip;</code></td></tr>
<tr><td>Credentials</td><td>none</td><td><code>Authorization: Bearer &lt;token&gt;</code></td></tr>
<tr><td>Chat output cap</td><td>512 tokens</td><td>1024 tokens</td></tr>
<tr><td>Memory profile</td><td>not retained</td><td>retained per user</td></tr>
</table>

<h2>Endpoints</h2>

<h3>POST /api/chat &middot; /api/chat/guest</h3>
<p>Streaming conversational completion. <code>mode</code> is one of
<code>balanced</code>, <code>creative</code> or <code>logical</code>.
<code>attachments</code> may carry up to 5 base64-encoded files. Bodies are limited
to 6&nbsp;MiB. Any <code>system</code> message supplied by the client is discarded
server-side.</p>
<pre><code>{
  "messages": [{ "role": "user", "content": "Explain TLS session resumption." }],
  "mode": "balanced"
}</code></pre>
<p>The response is <code>text/event-stream</code>. Each <code>data:</code> line holds a
JSON object with a <code>response</code> token delta; the stream ends with
<code>data: [DONE]</code>.</p>

<h3>POST /api/image/generate &middot; /api/image/generate/guest</h3>
<pre><code>{ "prompt": "a red cube on a white background, studio lighting" }</code></pre>
<p>Returns <strong>raw image bytes</strong>, not JSON &mdash; <code>image/jpeg</code>
from the primary provider, <code>image/png</code> from the fallback. Bodies are
limited to 64&nbsp;KiB.</p>

<h3>POST /api/vision/analyze &middot; /api/vision/analyze/guest</h3>
<pre><code>{ "image": "&lt;base64&gt;", "mimeType": "image/png", "question": "What is this?" }</code></pre>
<p>Returns <code>{ "analysis": "&hellip;" }</code>. <code>question</code> is optional.</p>

<h3>POST /api/search/ground &middot; /api/search/ground/guest</h3>
<pre><code>{ "query": "current CVE severity scoring changes" }</code></pre>
<p>Returns <code>{ "answer": "&hellip;", "sources": [{ "title": "&hellip;", "url": "&hellip;" }] }</code>.</p>

<h3>POST /api/enhance-prompt</h3>
<p>Rewrites a rough prompt into a more effective one. Returns
<code>{ "enhanced": "&hellip;" }</code>. Input is truncated to 2000 characters.</p>

<h3>GET /api/v1/health</h3>
<p>Static liveness and advertised capabilities. Touches no model provider, so
polling it costs nothing.</p>

<h2>Errors</h2>
<p>Errors are JSON objects of the form <code>{ "error": "&hellip;" }</code>.</p>
<table>
<tr><th>Status</th><th>Meaning</th></tr>
<tr><td><code>400</code></td><td>A required field is missing or empty</td></tr>
<tr><td><code>401</code></td><td>Missing or invalid bearer token &mdash; see the <code>WWW-Authenticate</code> header</td></tr>
<tr><td><code>405</code></td><td>Method not allowed on this path</td></tr>
<tr><td><code>413</code></td><td>Request body exceeds the size limit</td></tr>
<tr><td><code>500</code></td><td>Upstream model or provider failure</td></tr>
<tr><td><code>503</code></td><td>The provider backing this endpoint is not configured</td></tr>
</table>

<h2>For agents</h2>
<ul>
<li>Every page here is available as markdown. Send <code>Accept: text/markdown</code>,
or fetch the stable URL directly (<a href="/index.md">/index.md</a>,
<a href="/docs.md">/docs.md</a>).</li>
<li><a href="/.well-known/api-catalog">/.well-known/api-catalog</a> returns an RFC 9727
linkset pointing at this document, the OpenAPI description and the health endpoint.</li>
<li><code>/mcp</code> speaks Model Context Protocol over Streamable HTTP. Its card is at
<a href="/.well-known/mcp.json">/.well-known/mcp.json</a>.</li>
<li>Reusable skills are indexed at
<a href="/.well-known/agent-skills/index.json">/.well-known/agent-skills/index.json</a>,
each with a SHA-256 digest of its content.</li>
</ul>

<footer>EleenAI &middot; <a href="/">Application</a> &middot;
<a href="/docs.md">This page as markdown</a> &middot;
<a href="/api/v1/openapi.json">OpenAPI</a></footer>
</main>
</body>
</html>
`;
