---
name: eleenai-image-generation
description: Generate images from text prompts using the EleenAI image endpoint, which returns raw image bytes rather than JSON.
---

# EleenAI Image Generation

Generate an image from a text description.

## Endpoint

| Tier | Path | Credentials |
|---|---|---|
| Guest | `POST /api/image/generate/guest` | none |
| Authenticated | `POST /api/image/generate` | `Authorization: Bearer <token>` |

Base URL: `https://eleenai.xyz`

## Request

```json
{ "prompt": "a red cube on a white background, studio lighting, photorealistic" }
```

`prompt` is required and must be non-empty. The request body is limited to
64 KiB.

## Response

**The response body is raw image bytes, not JSON.** Read it as binary.

`Content-Type` is `image/jpeg` when served by the primary provider and
`image/png` when served by the fallback, so branch on the header rather than
assuming a format or file extension.

## Writing effective prompts

Detailed prompts produce markedly better results than terse ones. Include:

- Subject and composition — what is in frame, and where
- Style — photorealistic, digital art, oil painting, isometric, line drawing
- Lighting — studio, golden hour, backlit, high key
- Camera or medium — macro, wide angle, 35mm, watercolour

> `a red cube` → `a single glossy red cube centred on a white seamless
> backdrop, soft studio lighting from the upper left, subtle contact shadow,
> product photography, 50mm`

## Example

```bash
curl -X POST https://eleenai.xyz/api/image/generate/guest \
  -H 'content-type: application/json' \
  -d '{"prompt":"a red cube on a white background, studio lighting"}' \
  --output cube.png
```

```python
import requests

r = requests.post(
    "https://eleenai.xyz/api/image/generate/guest",
    json={"prompt": "a red cube on a white background, studio lighting"},
)
r.raise_for_status()

ext = "jpg" if "jpeg" in r.headers["content-type"] else "png"
with open(f"cube.{ext}", "wb") as f:
    f.write(r.content)
```

## Errors

Error responses *are* JSON, so a `content-type` of `application/json` on this
endpoint always indicates failure.

`400` missing or empty prompt · `401` missing or invalid token on the
authenticated path · `413` body over 64 KiB · `500` generation failed.

## Via MCP

The same capability is the `eleenai_generate_image` tool at
`https://eleenai.xyz/mcp`, which returns an MCP image content block with
base64 `data` and a `mimeType`.
