---
name: eleenai-chat
description: Converse with the EleenAI assistant over its HTTP API, including SSE stream parsing, response modes, uploaded files, and the guest versus authenticated tiers.
---

# EleenAI Chat

Send a conversation to EleenAI and read back a streamed reply.

## Endpoint

| Tier | Path | Credentials | Output cap |
|---|---|---|---|
| Guest | `POST /api/chat/guest` | none | 512 tokens |
| Authenticated | `POST /api/chat` | `Authorization: Bearer <token>` | 1024 tokens on the default model; larger models allow more |

`GET /api/v1/models` lists every model with its `access` requirement (`guest`,
`sign-in`, or `key-required`). It costs no inference.

Base URL: `https://eleenai.xyz`

## Request

```json
{
  "messages": [
    { "role": "user", "content": "Explain TLS session resumption." },
    { "role": "assistant", "content": "..." },
    { "role": "user", "content": "How does that interact with 0-RTT?" }
  ],
  "mode": "balanced"
}
```

- `messages` is required. Roles are `user` and `assistant`. A `system` message
  supplied by the client is discarded server-side, so it cannot be used to
  change the assistant's behaviour.
- `mode` is `balanced` (default), `creative`, or `logical`.
- `model` is optional: a model id or a tier name (`fast`, `smart`,
  `reasoning`) from `/api/v1/models`. Unknown values are a `422`; a model the
  caller may not use is a `403` with `reason` `sign-in` or `key-required`.
  The `reasoning` tier needs an authenticated caller.
- `protocol` is optional: `1` (default) for the framing below, `2` for named
  events (`meta`, `reasoning`, `token`, `usage`, `error`, `done`) that carry
  a reasoning model's thinking separately from its answer.
- `compare` is optional, authenticated only: 2 or 3 distinct model ids or
  tier names that all answer the turn (needs `protocol` 2, not combined with
  `model`). Every event then carries `lane`, the model's index; each lane
  ends with its own `done`, and the stream with a `done` that has no lane.
- `files` is optional (signed in only): up to 4 ids returned by
  `POST /api/v1/files`, which takes the file as the raw body with an
  `x-file-name` header. Inline base64 `attachments` are no longer accepted.
- The request body is limited to 6 MiB.

## Response

`Content-Type: text/event-stream`. Each event is a `data:` line holding a JSON
object with a `response` string carrying the next token delta. The stream ends
with the literal `data: [DONE]`.

```
data: {"response":"TLS"}
data: {"response":" session"}
data: {"response":" resumption"}
data: [DONE]
```

Concatenate every `response` value in order to reconstruct the full reply.

### Control markers

The reply may contain markers intended for the web interface. Strip them
before presenting the text:

| Marker | Meaning |
|---|---|
| `[TOOL:think]`, `[TOOL:search]`, `[TOOL:vision]`, `[TOOL:generate]` | Activity indicator at the start of a reply |
| `[IMG_GEN]…[/IMG_GEN]` | An image generation request — pass the enclosed text to the image endpoint |
| `[SUGGEST]a\|b\|c[/SUGGEST]` | Suggested follow-up questions |

## Example

```bash
curl -N -X POST https://eleenai.xyz/api/chat/guest \
  -H 'content-type: application/json' \
  -d '{"messages":[{"role":"user","content":"Hello"}]}'
```

```python
import json, requests

with requests.post(
    "https://eleenai.xyz/api/chat/guest",
    json={"messages": [{"role": "user", "content": "Hello"}]},
    stream=True,
) as r:
    for line in r.iter_lines():
        if not line or not line.startswith(b"data:"):
            continue
        payload = line[5:].strip()
        if payload == b"[DONE]":
            break
        print(json.loads(payload).get("response", ""), end="")
```

## Errors

`400` missing or empty `messages` · `401` missing or invalid token on the
authenticated path · `413` body over 6 MiB · `500` upstream model failure.

Errors are JSON: `{ "error": "..." }`.

## Via MCP

The same capability is exposed as the `eleenai_chat` tool at
`https://eleenai.xyz/mcp`, which returns the assembled text in one response
and needs no SSE parsing.
