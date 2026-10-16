# EleenAI

A multimodal AI chat assistant at [eleenai.xyz](https://eleenai.xyz), built on Cloudflare Workers.

- **Chat** on Workers AI open models in three tiers (fast, smart, reasoning), streamed over SSE, routed through AI Gateway.
- **Premium models** (OpenAI, Anthropic, Google, DeepSeek) run only on the user's own API key, stored encrypted in D1.
- **Voice input**, image generation, vision and web search.
- **Agent-ready:** MCP server at `/mcp`, OpenAPI at `/api/v1/openapi.json`, markdown renditions, agent skills, WebMCP.
- Sign-in with Clerk. Rate limits in D1. Prompt-injection defence and output filtering in `src/ai/guard.ts`.

## Layout

| Path | What |
|---|---|
| `src/` | The Worker: routing, chat handler, providers, guard, rate limits, agent surfaces |
| `web/` | The frontend, built by Vite into `dist/` |
| `migrations/` | D1 schema |
| `test/` | Unit and worker tests (vitest) |
| `e2e/` | Browser tests (Playwright) |
| `DESIGN.md` | The design system contract |
| `docs/status/` | Status write-ups, newest last: [EndofJuly](docs/status/EndofJuly.md), [Mid-August](docs/status/Mid-August.md), [Mid-October](docs/status/Mid-October.md) |
| `infra/`, `assets/scene/` | Reference copies of Cloudflare-side configuration and the 3D scene |

## Develop

```
npm ci
npm run dev          # wrangler dev on :8787, builds web/ first
npx vitest run       # unit + worker tests
npm run e2e          # browser tests against local dev
npm run check        # digests, typecheck, dry-run deploy
```

Secrets for local dev go in `.dev.vars` (gitignored): `CLERK_SECRET_KEY`, `GEMINI_API_KEY`, `KEY_ENCRYPTION_KEY`.

Local dev never shows the 3D scene: R2 refuses CORS from localhost. Check anything layered over the scene against production.

## Deploy

From a clean `main`:

```
npm run deploy           # refuses a dirty tree, stamps the build with the commit
npm run verify-deploy    # confirms production reports the same commit
```

Apply new D1 migrations first with `npm run db:migrate:remote`.
