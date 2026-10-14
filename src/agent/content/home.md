# EleenAI

A multimodal AI assistant. EleenAI holds a conversation, generates images,
reads images and documents, and answers questions grounded in live web search
with citations.

This is the markdown rendition of <https://eleenai.xyz>, served for agents and
other non-browser clients. The interactive application is at the same URL in a
browser.

## Capabilities

| Capability | Description |
|---|---|
| Chat | Streaming conversational completions, with `balanced`, `creative` and `logical` response modes |
| Image generation | Text-to-image from a prompt |
| Vision | Analysis of uploaded images and documents |
| Web search | Answers grounded in live search results, returned with sources |

## Programmatic access

| Resource | URL |
|---|---|
| OpenAPI 3.1 description | `/api/v1/openapi.json` |
| Documentation | `/docs` (HTML) · `/docs.md` (markdown) |
| API catalog (RFC 9727) | `/.well-known/api-catalog` |
| Health | `/api/v1/health` |
| Authentication guide | `/auth.md` |

A minimal call needs no credentials:

```
curl -X POST https://eleenai.xyz/api/chat/guest \
  -H 'content-type: application/json' \
  -d '{"messages":[{"role":"user","content":"Hello"}]}'
```

The response is a `text/event-stream`; each `data:` line carries a JSON object
with a `response` token delta, terminating with `data: [DONE]`.

## MCP

EleenAI speaks Model Context Protocol over Streamable HTTP at
`https://eleenai.xyz/mcp`, exposing `eleenai_chat`, `eleenai_generate_image`
and `eleenai_search`.

The server card is at `/.well-known/mcp.json`. The endpoint works without
credentials in the guest tier.

## Authentication

Protected endpoints take a bearer token in the `Authorization` header. Tokens
are issued by the authorization server named in
`/.well-known/oauth-protected-resource`; EleenAI does not issue them itself.

Full details, including the `WWW-Authenticate` challenge format and the
available scopes, are in [/auth.md](https://eleenai.xyz/auth.md).

## Agent skills

Reusable skills describing how to drive this API are indexed at
`/.well-known/agent-skills/index.json`, each entry carrying a SHA-256 digest of
the skill document it points at.

## Content negotiation

Every documentation surface is available as markdown. Send
`Accept: text/markdown`, or fetch the stable URL directly — `/index.md` for
this page, `/docs.md` for the API reference.
