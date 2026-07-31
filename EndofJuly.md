# EleenAI — End of July 2026

**Date:** 2026-07-31
**Repo:** https://github.com/Cyb0rgbytes/eleen-ai-beta-v1 (public)
**Branch:** `feat/agent-readiness`
**Tests:** 41 passing (`npx vitest run`)
**Build:** `npm run check` clean
**Deployed:** No. `wrangler deploy` has never been run.

---

## Where things actually stand

Phases 0–2 are built and committed. Phases 3–5 are not started. **No frontend work has begun** —
the July planning produced a detailed implementation plan, but not a line of code. The UI you see
locally today is the same one from commit `71ff806`.

| | |
|---|---|
| `main` | `50ffe75` — Phase 0 hotfix only. Builds and deploys. |
| `feat/agent-readiness` | `71ff806` — 6 commits on top. Pushed, PR still not opened. |
| Working tree | Clean apart from a one-line `.gitignore` edit and this file. |

### Commit history on the branch

```
50ffe75  fix: resolve merge conflicts, remove stale duplicates, normalize line endings   [main]
76e3437  chore: route / through the Worker and enable Text imports for *.md
30d6b77  feat: agent-readiness surfaces — sitemap, Link headers, markdown, catalog, OAuth, MCP
0b24c70  feat: agent skills discovery and WebMCP
72843c2  docs: DNS-AID record set, and hash the served card rather than parsing source
13f7578  feat: Phase 2 — abuse control, input validation, security headers, injection defence
71ff806  refactor: simplify the chat panel and rewrite style.css
```

---

## Accomplished

### Phase 0 — Rescue
The site was dead on arrival: `chat.js`, `index.html` and `src/index.ts` all carried unresolved
merge-conflict markers. Resolved them, deleted the stale `spline-cdn/` duplicate directory, removed
`src/index.js` and `wrangler.toml`, added `.gitattributes`, tagged the baseline.

### Phase 1 — Agent readiness
Machine-readable renditions of the whole site, so LLM agents can consume it directly:
- `/sitemap.xml`, RFC 8288 `Link` headers on `/` and `/docs`
- `Accept: text/markdown` content negotiation → `/index.md`, `/docs.md`, `/auth.md`
- RFC 9727 `/.well-known/api-catalog`, RFC 9728 OAuth protected-resource metadata
- OpenAPI 3.1 document at `/api/v1/openapi.json`, health at `/api/v1/health`
- A real MCP JSON-RPC server over Streamable HTTP at `/mcp` (stateless)
- Agent-skills index with digests computed at runtime from the served bytes
- WebMCP (`public/js/webmcp.js`) exposing `new_chat`, `send_message`, `set_model`,
  `export_conversation` to browser-resident agents
- DNS-AID record set documented (publishing is a manual action)

### Phase 2 — Security hardening
- **Rate limiting** (`src/lib/ratelimit.ts`) — KV-backed fixed windows, per-hour. Guests keyed on
  `sha256(ip + window)` truncated to 32 chars, never a raw IP. Authed on the Clerk `userId`.
  Buckets: chat 20/200, image 5/50, vision 10/100, search 10/100, enhance 15/100. Fails open.
- **Input validation** (`src/lib/validate.ts`) — accumulating validators returning 422 with a
  `details[]` array. 18 unit tests.
- **Security headers** (`src/lib/security-headers.ts`) — CSP (Report-Only), HSTS, `nosniff`,
  `X-Frame-Options: DENY`, COOP, Permissions-Policy. `microphone=(self)` set deliberately in
  advance of the voice work.
- **Prompt-injection defence** (`src/ai/guard.ts`) — five layers: nonce-delimited untrusted-content
  wrapping, injection assessment on the latest user turn, a canary planted in the system prompt,
  outbound SSE stream filtering that cuts and replaces the stream if the canary or infrastructure
  details leak. 23 unit tests.
- **CORS** (`src/lib/cors.ts`) — explicit allowlist, preflight handling.

### Phase 3 (July) — Planning only, no code
Investigated and specified the frontend rebuild. The measurement work produced one finding that
changed the approach entirely — see below.

---

## The Spline finding

The 3D background was assumed to be slow because the model is heavy. Measured over the wire, it
is not:

| Asset | Compressed | Parsed |
|---|---|---|
| `r_4_x_bot.splinecode` (the scene, from R2) | 46 KB | — |
| `@splinetool/viewer@1.12.88` (the runtime, from unpkg) | 650 KB gzip | **2.29 MB** |

The runtime is **98.5% of the payload and 100% of the JS parse cost**, and it is loaded in `<head>`
with `fetchpriority="high"` — so 2.29 MB of JavaScript compiles before the chat is usable.
Optimising the scene would achieve nothing. There is no lighter build in the package
(`spline-viewer.cjs` is the same bundle, 506 bytes larger), and jsDelivr's brotli is 4 KB *worse*
than unpkg's gzip. The fix is deferral, not compression.

Two live defects found alongside:
- `assets.eleenai.xyz/r_4_x_bot.splinecode` returns `cf-cache-status: DYNAMIC` with **no
  `Cache-Control` header reaching the client**, despite the Worker setting one. Every visitor hits
  the R2 origin.
- `pub-…r2.dev/spline-assets/r_4_x_bot.splinecode` 404s. The object lives at the bucket root —
  `spline-assets` is the bucket name, not a key prefix.

---

## Todo

### Phase 1 of the frontend plan — next up

- [ ] **Theming pass** on `style.css` — tokens + `[data-theme="light"]`. ~20 hardcoded colours
      currently bypass the token set; migrating them is the *prerequisite* for any toggle.
- [ ] **Dark / light mode toggle** — persisted to `localStorage`, `prefers-color-scheme` as the
      initial default, synchronous no-flash bootstrap in `<head>`.
- [ ] **Spline deferral** — dynamic `import()` on idle behind an instant poster backdrop; skip on
      mobile / save-data / low-core / reduced-motion. Fix the R2 cache headers.
- [ ] **Gemini-style panel** — 560px, frosted glass retained, gradient greeting, 2×2 prompt cards,
      pill composer, mode pills moved into a popover.
- [ ] Delete the dead particle system (~140 lines, `#particle-bg` isn't in the DOM) and
      `public/background.png` (3.2 MB, referenced by nothing).

### Phase 2 of the frontend plan — specified, not started

- [ ] **Consent + privacy policy** — first, because it gates everything that stores data.
      Four categories: essential (locked) / chat_storage / personalisation / analytics.
- [ ] **Voice notes** — 30s cap, `@cf/openai/whisper-large-v3-turbo`, transcript into the composer
      for review, never auto-sent.
- [ ] **Chat history** — D1. Bind the *existing* `eleen-db`
      (`6a11307f-335d-4269-b615-94912feaea85`, currently 0 tables). List / create / rename / delete
      / FTS5 search. Guests get localStorage-only with an import-on-sign-in path.
- [ ] **Usage dashboard** — D1 `usage_counters` for history plus a new non-mutating
      `peekRateLimit()` for the current window.

### Known issues worth fixing regardless

- [ ] **`openapi.ts:254` lies** — it tells API consumers "conversation history is persisted". What
      is actually stored is a 2 KB summarised profile. That file's own header says a description
      that lies is worse than none.
- [ ] **`chat.js` never handles 429.** The server rate-limits, but the client throws `HTTP 429`
      into the generic "Sorry, there was an error" bubble.
- [ ] **`currentMode` is never sent to the server.** The request body is only `{ messages }`, though
      `validateChatBody` accepts a `mode` field — so the Balanced/Creative/Logical selector
      currently does nothing server-side.
- [ ] **The KV memory profile has no notice or opt-out.** It is already collecting name, job,
      location and preferences with a 90-day TTL. This is the most pressing gap.
- [ ] **`vitest` is not wired to `@cloudflare/vitest-pool-workers`.** No `vitest.config.ts` exists,
      so tests run in plain Node and nothing touching KV / `Env` / `Request` can be tested.

### Manual actions — cannot be done in code

- [ ] Open the PR and merge
- [ ] Enable DNSSEC on `eleenai.xyz` + DS record at the registrar, then publish the DNS-AID records
- [ ] Migrate Clerk to production (currently `pk_test_…`, instance `feasible-falcon-93`)
- [ ] Fix `.dev.vars` — both Clerk keys are 18-char placeholders, so authenticated routes 500 locally
- [ ] Review 50 Dependabot alerts (6 critical, 22 high); close the 3 PRs targeting the deleted
      `spline-cdn/`
- [ ] Deploy. Nothing has ever been deployed.
