# EleenAI, End of October 2026

**Dates:** 2026-10-23 to 2026-10-24
**Repo:** https://github.com/Cyb0rgbytes/eleen-ai-beta-v1 (public)
**Deployed:** production runs `d19fad6`, verified with `scripts/verify-deploy.mjs`. Later merges (`#52`) are test-only.
**Tests:**
- 764 unit, worker and web tests pass (`npx vitest run`).
- Locally, 94 browser tests pass and 4 are skipped (`npx playwright test`); the skipped ones run only against production.
- Against production, 96 pass and 1 is skipped; the one failure was a test bug, since fixed in `#52`.

**Build:** `npm run check` is clean. Initial JavaScript is 62.8 KB gzip against an 80 KB budget.

Continues from [Late-October.md](Late-October.md). Phases 0–5 of the plan and the final security audit are now **done and live**.

---

## Where things stand

| Milestone | Status |
|---|---|
| M4.1–M4.6 history, consent, theming | Done and live (M4.1/4.2/4.5/4.6 before this session). |
| M4.3 branching | Done and live (`#38`). |
| M4.4 sidebar | Done and live (`#39`). |
| Phase 4 cleanup | Done and live (`#40`, `#41`, `#42`, `#47`). |
| M5.1 voice | Already in place before this session (recording, transcription, spoken replies, voice commands). |
| M5.2 uploads | Done and live (`#44`, migration `0004`). |
| M5.3 export | Done and live (`#43`). |
| M5.4 compare | Done and live (`#45`). |
| M5.5 PWA and speed | Done and live (`#46`). |
| Final security audit | Done; findings fixed in `#48`, `#49` and `#50`, live. |

---

## What landed

### Phase 4 completion

- **Shared base (`#37`):**
  - `POST /api/v1/conversations/:id/restore`.
  - Saved-chat ids on the stream's `meta` event.
  - `web/src/history/` (API client, tree helpers, shared state).
  - Consent now tells the chat and the sidebar whether to save.
- **M4.3 branching (`#38`):**
  - Saved turns go by id, and the server rebuilds the context itself.
  - Regenerate and Edit create sibling branches, with a ‹n/m› navigator to switch between them.
  - Stop keeps the partial reply.
  - `chat.openConversation()`.
- **M4.4 sidebar (`#39`):**
  - Search, New chat, Pinned, Folders and Recent.
  - Rename, pin, move, and delete with Undo.
  - A drawer on phones; RTL; loaded on demand, so guests never download it.
- **Cleanup (`#40`):**
  - **Recently deleted:** chats can be restored for 30 days. A daily cron (`17 3 * * *`) then purges them, and the privacy page says so in EN and AR.
  - **Clerk:** the popups follow the light and dark theme.
  - **Send button:** contrast fixed, and Stop now has its own look.
  - **Favicons:** cut from the logo, with `/favicon.ico` redirecting to them.
- **CSP enforced (`#41`):**
  - The main policy is enforced; Trusted Types stays Report-Only.
  - `CSP_MODE=report` in `wrangler.jsonc` is the way back.
  - The only reports in the 48-hour window came from the scene's `rel=prefetch`; it is now a `preload`.

### Phase 5

- **M5.2 uploads (`#44`):**
  - **Route:** `POST /api/v1/files` stores files privately in R2 bucket `eleen-uploads` under `u/{userId}/`.
  - **Checks:** the type is sniffed from the bytes, with a 10 MB cap.
  - **Text:** extracted with `env.AI.toMarkdown`, screened and wrapped as untrusted before the model sees it.
  - **Images:** vision models get the image itself; the free models get a description written at upload time.
  - **Saved chats:** they remember their files.
  - **Delete all:** "Delete all conversations" also removes the files.
- **M5.4 compare (`#45`):**
  - **Models:** 2–3 models answer on one multiplexed stream, each event tagged with `lane`. Signed-in users only.
  - **Display:** columns on desktop, tabs on phones.
  - **Saving:** the answers are saved as siblings, and "Continue with this answer" picks one.
  - **Files:** these work with Compare too; every lane gets the same text and image descriptions.
- **M5.3 export (`#43`):**
  - **Formats:** Markdown, JSON (optionally with every branch), and Print / Save as PDF with Arabic shaped correctly.
  - **Where:** in the chat, and from the sidebar's menu for saved chats.
- **M5.5 PWA (`#46`):**
  - **Install:** manifest and maskable icons.
  - **Service worker:**
    - It precaches only hashed assets and fonts, and is network-first for pages, with an offline page.
    - It never touches `/api`, `/mcp` or other origins.
    - It never takes over a tab that's already open.
  - **Speed:** the scene loads when the browser is idle, and the logo is now a WebP. Mobile Lighthouse went from 84 to 90, and CLS from 0.159 to 0.003 (measured locally).

### Final security audit and fixes

- **The audit:** three independent read-only reviews.
  - **Access:** authorization and access across users.
  - **Content:** injection and untrusted content.
  - **Platform:** headers, service worker, dependencies, secrets and config.
- **Result:** no Critical or High findings, 2 Medium and 18 Low, all recorded in `docs/security/audit-2026-10-final.md`. That file is gitignored, because the repo is public.
- **S1 (`#48`):**
  - Inline base64 `attachments` are retired; they return 422 and point to `/api/v1/files`.
  - The CSP allows only the pinned Spline and Clerk build paths, not whole hosts.
  - REST and MCP accept the Bearer token only; Clerk is never shown cookies.
- **S3 (`#49`):**
  - `/api/csp-report` has caps and a rate limit.
  - A new `web/public/_headers` adds `nosniff` and `immutable` caching for assets.
  - Log hygiene: user ids are hashed, upstream error bodies cut, and error objects reduced to their messages.
  - `workers_dev` and `preview_urls` are off.
  - CORS no longer credits `assets.eleenai.xyz`, and localhost tokens work only on localhost.
  - The Markdown export makes images and HTML inert.
  - zod is pinned to 4.6.6 (a dev advisory).
  - `.claude/` is in `.gitignore`, and two stale Dependabot PRs are closed.
- **S2 (`#50`):**
  - Invisible-Unicode, emphasis and multilingual tricks no longer get past the screen.
  - The closing delimiter now carries the nonce.
  - Image generation from a turn with files, or a flagged turn, needs a click.
  - File names are screened.
  - Memory reads only the user's own lines.
  - A stronger canary check covers the reasoning and the answer together.
  - The red-team suite has many more cases.
- **Verified on production after the deploy:**
  - The narrowed CSP blocks nothing (the scene and Clerk sign-in work).
  - `workers.dev` returns 404.
  - Inline attachments return 422, and a cookie-only request returns 401.
  - Assets carry the new headers.

---

## How we worked

- **Parallel agents:** up to three agents worked in git worktrees, each on its own test port, and opened PRs against `main`.
- **Integration:** branches that touched the same files were combined and tested together, then chained so each PR merged cleanly.
- **Who did what:** the owner merged every PR, and approved the migration and the deploys. Deploys ran with `npm run deploy` and were checked with `scripts/verify-deploy.mjs` plus the Playwright suite against production.
- **Logs:** the Cloudflare observability connector can count and group log entries, but not show individual ones. Paste entries from the dashboard when their contents matter.

---

## Open items

**For the owner:**
- **Signed-in test on the live site:** upload a real PDF (extraction has only run against a fake so far), a Compare turn, Export and Print, installing the app on a phone, and a branching and sidebar run-through.
- **Logs:** check in the dashboard whether Workers Logs store full request URLs or `Cookie` / `Authorization` headers.

**Deferred (from the audit report):**
- Upgrade `vitest` to 4.1.12 once that release is two weeks old (from about 2026-10-29). It fixes two Moderate advisories, dev only.
- A per-user storage cap; delete a chat's files when it is purged; sweep uploads that were never sent.
- Send history search as POST, so the search terms stay out of URL logs.
- SRI hashes on the pinned Clerk and Spline scripts.
- Isolate the Spline viewer in its own document, so the main CSP can drop `'unsafe-eval'`.
- Fix the key-rotation AAD issue in `src/lib/keys.ts` before rotating `KEY_ENCRYPTION_KEY`.
- Route `env.AI.toMarkdown` through the AI Gateway.
- Long documents are cut to their start and end; ranking passages with bge-m3 is a follow-up.
- Optional: import the 7 legacy conversations from `legacy_conversations_2026`.

**Next phase:** Phase 6+ backlog (per-message cost display, subscriptions, agent mode, deep research, and more). It isn't planned yet.
