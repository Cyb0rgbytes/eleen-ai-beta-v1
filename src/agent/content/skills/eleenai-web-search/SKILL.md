---
name: eleenai-web-search
description: Answer questions with live web search through EleenAI, returning a grounded answer together with the source URLs it was based on.
---

# EleenAI Web Search

Answer a question using live web search, returning both the answer and the
sources it was grounded on.

## Endpoint

| Tier | Path | Credentials |
|---|---|---|
| Guest | `POST /api/search/ground/guest` | none |
| Authenticated | `POST /api/search/ground` | `Authorization: Bearer <token>` |

Base URL: `https://eleenai.xyz`

## Request

```json
{ "query": "what changed in CVSS 4.0 severity scoring" }
```

`query` is required and must be non-empty. Phrase it as a natural-language
question rather than keywords — the query is answered, not just matched.

## Response

```json
{
  "answer": "CVSS 4.0 restructured the metric groups ...",
  "sources": [
    { "title": "CVSS v4.0 Specification", "url": "https://www.first.org/cvss/v4-0/" }
  ]
}
```

`sources` may be empty when the answer needed no external grounding. When it
is populated, cite it — the point of this endpoint over plain chat is that its
claims are attributable.

## When to use this

Prefer this over `eleenai-chat` whenever the answer depends on information
that changes: current events, releases, prices, standards revisions, or
anything where "as of today" matters. For reasoning, code, or stable general
knowledge, plain chat is faster and cheaper.

## Example

```bash
curl -X POST https://eleenai.xyz/api/search/ground/guest \
  -H 'content-type: application/json' \
  -d '{"query":"what changed in CVSS 4.0 severity scoring"}'
```

```python
import requests

r = requests.post(
    "https://eleenai.xyz/api/search/ground/guest",
    json={"query": "what changed in CVSS 4.0 severity scoring"},
)
r.raise_for_status()
data = r.json()

print(data["answer"])
for s in data["sources"]:
    print(f"- {s['title']}: {s['url']}")
```

## Errors

`400` missing or empty query · `401` missing or invalid token on the
authenticated path · `500` upstream failure · `503` the search provider is not
configured on this deployment.

Errors are JSON: `{ "error": "..." }`.

## Via MCP

The same capability is the `eleenai_search` tool at
`https://eleenai.xyz/mcp`, which returns the answer with the sources appended
as a markdown list.
