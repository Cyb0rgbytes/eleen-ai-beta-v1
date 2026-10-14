# EleenAI API Documentation

EleenAI is a multimodal AI assistant. It exposes streaming chat, text-to-image
generation, image and document understanding, and web-search-grounded answers
with citations.

The machine-readable description of everything below is at
[`/api/v1/openapi.json`](https://eleenai.xyz/api/v1/openapi.json) (OpenAPI 3.1).

- Base URL: `https://eleenai.xyz`
- Catalog: `/.well-known/api-catalog`
- Health: `/api/v1/health`
- Authentication: [`/auth.md`](https://eleenai.xyz/auth.md)
- MCP endpoint: `https://eleenai.xyz/mcp`

## Tiers

Most capabilities are reachable two ways.

| | Guest | Authenticated |
|---|---|---|
| Path | `/api/…/guest` | `/api/…` |
| Credentials | none | `Authorization: Bearer <token>` |
| Chat output cap | 512 tokens | 1024 tokens |
| Memory profile | not retained | retained per user |

Tokens are issued by the authorization server named in
`/.well-known/oauth-protected-resource`. EleenAI does not issue them itself.

## Endpoints

### `POST /api/chat` · `POST /api/chat/guest`

Streaming conversational completion.

```json
{
  "messages": [{ "role": "user", "content": "Explain TLS session resumption." }],
  "mode": "balanced"
}
```

`mode` is one of `balanced`, `creative` or `logical`. `attachments` may carry up
to 5 base64-encoded files. Request bodies are limited to 6 MiB. Any `system`
message supplied by the client is discarded server-side.

The response is `text/event-stream`. Each `data:` line holds a JSON object with
a `response` string carrying the next token delta; the stream ends with
`data: [DONE]`.

```
data: {"response":"TLS"}
data: {"response":" session"}
data: [DONE]
```

### `POST /api/image/generate` · `POST /api/image/generate/guest`

```json
{ "prompt": "a red cube on a white background, studio lighting" }
```

Returns **raw image bytes**, not JSON — `image/jpeg` from the primary provider,
`image/png` from the fallback. Request bodies are limited to 64 KiB.

### `POST /api/vision/analyze` · `POST /api/vision/analyze/guest`

```json
{ "image": "<base64>", "mimeType": "image/png", "question": "What is this?" }
```

Returns `{ "analysis": "…" }`. `question` is optional. Returns `503` when the
vision provider is not configured on the deployment.

### `POST /api/search/ground` · `POST /api/search/ground/guest`

```json
{ "query": "current CVE severity scoring changes" }
```

Returns an answer together with the sources it was grounded on:

```json
{
  "answer": "…",
  "sources": [{ "title": "NVD", "url": "https://nvd.nist.gov/" }]
}
```

Returns `503` when the search provider is not configured.

### `POST /api/enhance-prompt`

```json
{ "prompt": "make me a website" }
```

Returns `{ "enhanced": "…" }`. The input is truncated to 2000 characters.

### `GET /api/v1/health`

```json
{ "status": "ok", "version": "1.0.0", "service": "eleenai",
  "capabilities": ["chat", "image-generation", "vision", "web-search", "mcp"] }
```

Static, and deliberately touches no model provider — polling it costs nothing.

## Errors

Errors are JSON objects of the form `{ "error": "…" }`.

| Status | Meaning |
|---|---|
| `400` | A required field is missing or empty |
| `401` | Missing or invalid bearer token — see the `WWW-Authenticate` header |
| `405` | Method not allowed on this path |
| `413` | Request body exceeds the size limit |
| `500` | Upstream model or provider failure |
| `503` | The provider backing this endpoint is not configured |

## For agents

- Every page here is available as markdown. Send `Accept: text/markdown`, or
  fetch the stable `.md` URL directly (`/index.md`, `/docs.md`).
- `/.well-known/api-catalog` returns an RFC 9727 linkset pointing at this
  document, the OpenAPI description and the health endpoint.
- `/mcp` speaks Model Context Protocol over Streamable HTTP. Its card is at
  `/.well-known/mcp.json`.
- Reusable skills are indexed at `/.well-known/agent-skills/index.json`, each
  with a SHA-256 digest of its content.
