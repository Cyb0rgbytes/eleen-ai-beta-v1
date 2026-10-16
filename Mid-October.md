# EleenAI, Mid-October 2026

**Date:** 2026-10-16
**Repo:** https://github.com/Cyb0rgbytes/eleen-ai-beta-v1 (public)
**Branch:** `main` at `2285583`, six commits ahead of the last push
**Tests:** 197 passing (`npx vitest run`, unit + worker), 7 browser tests passing (`npm run e2e`)
**Build:** `npm run check` clean
**Deployed:** production runs `aee04b7` (M3.4 complete). `b771d68` and `2285583` are not deployed yet.

Continues from [Mid-August.md](Mid-August.md), which stays accurate for everything before 2026-10-14.

---

## Where things stand

Phases 0 to 2 were done in July. The plan for Phases 3 to 5 was written on 2026-10-14 and lives outside the repo at `~/.claude/plans/start-the-phase-3-5-breezy-barto.md`. Against that plan:

| Milestone | Status |
|---|---|
| M0.1 Sync main | Done. Every branch merged, `main` is the deploy source. |
| M0.2 DESIGN.md, Playwright e2e | Done (`b771d68`). |
| M0.3 Test runtime | Done. vitest 4 with the Cloudflare plugin, unit and worker projects. |
| M0.4 D1 binding | Done. `eleen-db` bound, two migrations applied in production. |
| M0.5 Vite port, build stamp | Done (`2285583`), not yet deployed. |
| M3.1 Security audit and red-team suite | Done. `docs/security/audit-2026-10.md`, 56 red-team tests. |
| M3.2 Urgent fixes | Done and deployed. |
| M3.3 Rate limiting on D1 | Done and deployed. |
| M3.4 Registry, providers, SSE v2, user keys | Done and deployed (`4ef904f`, `aee04b7`). |
| M3.5 TypeScript frontend | Next. |
| M3.6 Picker, reasoning panel, enforcing CSP | Not started. |
| Phase 4 History, branching, theming, consent | Not started. |
| Phase 5 Uploads, export, compare, PWA | Not started, except voice input, which shipped early. |

---

## What landed since Mid-August

### 2026-10-14, four PRs

- **Security audit** of every route and trust boundary. 21 findings, the two highs (stored XSS in chat rendering reachable through prompt injection, and `/mcp` bypassing all rate limits) fixed the same day. Red-team corpus in English and Arabic under `test/redteam/`.
- **Test infrastructure.** vitest 4 with `@cloudflare/vitest-plugin`, two projects, D1 migrations applied per test file, CI running digests, typecheck and tests. No deploy step, by design.
- **Rate limiting moved to D1.** One atomic conditional upsert per check instead of a KV read-then-write. Guests fail closed on buckets that call paid APIs. A Workers Rate Limiting binding stops bursts before any database write.
- **Voice input.** Record in the browser, transcribe with Whisper on Workers AI, review in the composer before sending. Never auto-sent.

### 2026-10-15 to 16, this session

1. **Clerk moved to a production instance** (`6dd3d8b`, `e7fbf22`). Frontend API at `clerk.eleenai.xyz`, `pk_live` key, SDK served from the custom domain. Sign-in with Google, GitHub, Facebook and email works on the live site. The SDK is pinned to the **v5 line** (5.128.0): clerk-js 6.x `clerk.browser.js` ships without the sign-in components, and with it every Login click threw "Clerk was not loaded with Ui components".
2. **Gemini models replaced** (`a89831a`). `gemini-2.0-flash-exp` had been retired from the API, so vision, search and attachments were silently failing. Now `gemini-3.6-flash` for text and image input, which works on the free tier. Grounded search and image output return 429 on the free tier and need billing on the Google project.
3. **AI Gateway wired in** (`2b6d2af`). Every Workers AI call goes through `eleenai-gateway`, tagged by route. The gateway's Workers AI billing is on Standard, with "Require provider credentials" on and a daily spend limit set.
4. **M3.4 part one: registry, providers, SSE v2** (`4ef904f`). One model list replaces the hardcoded ids. Clients pick by id or tier (`fast`, `smart`, `reasoning`) via `model` in the chat body. `GET /api/v1/models` lists them with an `access` requirement. The stream parser reads all three provider shapes, including `<think>` blocks split across chunks. `protocol: 2` gives named events (`meta`, `reasoning`, `token`, `usage`, `error`, `done`); v1 is byte-identical to before and pinned by a test carrying the old implementation verbatim. Reasoning text is screened by its own output filter. The guard no longer blocks every mention of Cloudflare or Clerk, only phrases that describe this service.
5. **M3.4 part two: users' own provider keys** (`aee04b7`). Signed-in users store one key per provider at `/api/v1/keys`, checked with one inference-free call and stored AES-256-GCM under `KEY_ENCRYPTION_KEY` with the owner and provider bound into the ciphertext. Never returned, logged or placed in an error. Premium models (`openai/gpt-5.5`, `anthropic/claude-sonnet-5-5`, `anthropic/claude-opus-5-5`) are listed as key-required and refused before any provider call without one.
6. **M0.2: DESIGN.md and Playwright** (`b771d68`). The design contract for the rebuild: semantic tokens for both themes, the scrim, type scale with an Arabic face, the fixed layer table, RTL rules, component patterns. Browser tests in `e2e/` run against local dev or production without calling a model; the XSS spec replays the audit's payloads against the real `chat.js`.
7. **M0.5: Vite pipeline and build stamp** (`2285583`). Frontend in `web/`, built into `dist/`, served by the assets binding. `scripts/deploy.mjs` refuses a dirty tree and stamps `BUILD_SHA`; `/api/v1/health` reports it as `build`; `scripts/verify-deploy.mjs` compares production to local HEAD. Two unreferenced 3.2 MB images removed.

### Model tiers on Workers AI

| Tier | Model | Who |
|---|---|---|
| Fast | `@cf/meta/llama-3.1-8b-instruct-fp8` | Everyone. Pinned: it is what v1 clients always received. |
| Smart | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | Everyone. |
| Reasoning | `@cf/deepseek-ai/deepseek-r1-distill-qwen-32b` | Signed-in only. Thinking does not fit the 512-token guest cap. |

---

## Manual actions completed this session

- [x] Clerk production instance, DNS records (`clerk`, `accounts`, `clkmail`, two DKIM), Google and Facebook OAuth apps with the Clerk callback.
- [x] `CLERK_SECRET_KEY` set to the live key.
- [x] Gemini key rotated and stored as `GEMINI_API_KEY`. The old key had been stored as a secret *name*, readable in every listing.
- [x] `KEY_ENCRYPTION_KEY` generated, saved in the password manager, stored on the Worker; a different value in `.dev.vars`.
- [x] D1 migrations `0001_usage` and `0002_provider_keys` applied in production.
- [x] AI Gateway: Standard billing for Workers AI, Require provider credentials on, daily spend limit.

---

## Things worth remembering

- **Deploy only through `npm run deploy`.** It runs `scripts/deploy.mjs`, which refuses uncommitted tracked changes and stamps the build. Follow it with `npm run verify-deploy`. The two 2026-10-15 deploys that did not include the Clerk change were the last of the stale-checkout deploys.
- **Clerk stays on clerk-js v5.** The v6 browser bundle is core only. Memory note: `clerk-js-v5-pin`.
- **Gateway settings enforce the billing decision.** Unified billing with no credits fails every Workers AI call with `AiGatewayError 2021`. Require provider credentials turns a missing user key into a 400 instead of a charge to the owner. Memory note: `model-billing-decision`.
- **A wrangler D1 API call can fail with 7403 and succeed a minute later.** The token has D1 write. Retry before investigating.
- **The Gemini free tier serves text and image input only.** Grounded search and image output need billing on the `EleenAi` Google project. Until then web search fails and image generation falls back to Flux.
- **Local dev never shows the Spline scene** (R2 blocks CORS from localhost). Anything layered over the scene is checked against production with local CSS routed in.
- **Not yet verified live:** that the AI binding's `extraHeaders` carries a user's key through the gateway to OpenAI or Anthropic. It needs a signed-in session with a real key, which exists once the picker (M3.6) does.

---

## Still open

### Blocking nothing, do soon

- [ ] **Deploy main** (`npm run deploy`, then `npm run verify-deploy`). Brings M0.5 live; production is otherwise current.
- [ ] **Push main.** Six commits are local only. The October push failed on GitHub's email privacy setting (GH007).
- [ ] Delete the unused Worker secret named `secret`.
- [ ] Production D1 has a `conversations` table from the May prototype that nothing references. Phase 4 defines the real one; leave it until then.

### Gates for later work

- [ ] **Privacy page.** Facebook stays in Development mode (testers only) and Google shows an unverified-app notice until one exists. Planned in M4.6, worth pulling forward.
- [ ] **Google billing** on the `EleenAi` project, or a different search backend, before web search matters.
- [ ] **DNSSEC and the DNS-AID records**, carried over since July. `cap-sha256` unchanged this session (the MCP card did not change).
- [ ] The Impeccable plugin from the plan was not installed; it is managed from the interactive Claude Code session.

### Next milestones, in order

1. **M3.5** TypeScript frontend: `chat.js` into modules under `web/src`, v2 stream with abort, markdown with sanitisation, self-hosted fonts, icons, Spline viewer and Motion.
2. **M3.6** Picker, reasoning panel, CSP enforcing after 48 h report-only.
3. **Phase 4** D1 history (server-side context, so clients cannot forge turns), branching, sidebar, themes and Arabic, consent and privacy page.
4. **Phase 5** Uploads, export, compare, PWA and Spline deferral.
5. **Final re-audit** against the new surfaces.
