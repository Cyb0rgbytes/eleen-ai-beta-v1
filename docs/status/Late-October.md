# EleenAI, Late October 2026

**Date:** 2026-10-16
**Repo:** https://github.com/Cyb0rgbytes/eleen-ai-beta-v1 (public)
**Deployed:** production runs `6ab49b5` (the M3.5 frontend and the first Phase 3 visuals).
**Waiting to merge:** `feat/visual-pass` (three commits), then `feat/m3.6-picker-keys-reasoning` (three commits, stacked on it).
**Tests on the M3.6 branch:** 323 passing (`npx vitest run`: unit, worker, web), 29 browser tests passing and 2 skipped (`npm run e2e`; the 2 run only against production).
**Build:** `npm run check` clean. Initial JavaScript is 39.6 KB gzip against an 80 KB budget.

Continues from [Mid-October.md](Mid-October.md), which stays accurate for everything before the M3.5 rebuild.

---

## Where things stand

| Milestone | Status |
|---|---|
| M3.5 TypeScript frontend | Done and deployed. |
| Phase 3 visuals, motion, UX | Done. The first half is deployed; copy, regenerate, jump pill and the level meter wait in `feat/visual-pass`. |
| M3.6 enforcing CSP | Policy ready and still Report-Only. Needs a deploy, 48 hours of reports, then the owner's go-ahead to flip. |
| M3.6 picker, keys form, reasoning panel | Built and tested on `feat/m3.6-picker-keys-reasoning`. Not merged. |
| M3.6 live key check | Not done. Needs the owner's real provider key on production. |
| Phase 4 History, branching, theming, consent | Not started. |

---

## What landed

### M3.5, the TypeScript frontend (deployed)

The 1,024-line `chat.js` and three inline scripts are gone. The page is strict TypeScript under `web/src`, built by Vite.

- **No HTML sinks.** Nothing in `web/src` assigns `innerHTML`. Model output goes through the `marked` lexer and is built from an allowlist of elements. Markdown images render as links, never `<img>`, so a reply cannot leak data through an image URL. Links allow only http, https and mailto.
- **One API client.** Typed errors for rate limits with `Retry-After`, sign-in, forbidden models, validation, network and timeouts. A request body, which may be a provider key, never reaches an error.
- **The v2 stream.** Usage is shown, Send becomes Stop, and the client is tested against frames from the server's own encoder.
- **No third-party CDNs** except Clerk and the Spline viewer. Fonts are self-hosted from fontsource, with Noto Sans Arabic loaded by `unicode-range`. Icons are Phosphor glyphs generated into path data. Motion comes from npm.
- **Boot order fixed.** The scene loads first, auth loads last, and the composer is enabled on every path.

### Phase 3, visuals and motion

- Greeting and prompt cards, skeletons instead of dots, entrances by side, and a streaming rule that pulses only while tokens arrive.
- A WebP poster of the scene, used under reduced motion, save-data, slow networks, fewer than four cores or a coarse pointer. The 2.3 MB viewer loads only when the live scene is shown.
- On `feat/visual-pass`: copy and regenerate, a jump-to-latest pill, a recording level meter, and the composer focus bloom.
- Measured on production against the old page: LCP 1068 to 964 ms, load 1842 to 1240 ms, CLS about 0.

### Streaming fixed

Guardrails on `eleenai-gateway` buffered the whole chat stream. It is now off, with DLP on and checking requests. First text now arrives about 3.5 to 4.5 seconds after sending.

### The content security policy (on `feat/visual-pass`, Report-Only)

A sweep replaced production's policy with the candidate in enforce mode and ran every flow on desktop and mobile. The live scene, the poster, Clerk's sign-in modal, a chat turn and voice recording all worked.

- `img-src` no longer allows any https host. Only the page, Clerk avatars and the Spline badge remain.
- `connect-src` adds `fonts.gstatic.com`, which the Spline viewer fetches the scene's fonts from.
- **The two scripts the Cloudflare zone injects stay on.** Web Analytics' beacon host is allowed. For JavaScript Detections, which Bot Fight Mode cannot turn off, each HTML response carries a fresh 16-byte nonce, and Cloudflare stamps it on the script it injects.
- **Trusted Types is its own Report-Only policy.** Our one sink goes through a policy that accepts only the pinned viewer URL. Clerk's bundle and the Spline viewer still write raw strings, so Trusted Types cannot be enforced.
- `'unsafe-eval'` stays for the Spline viewer, which evaluates a string internally.

**Open question:** Cloudflare documents reading the nonce from the enforcing header. Whether it also reads Report-Only shows in the 48-hour report window.

### M3.6, picker, keys form and reasoning panel (on `feat/m3.6-picker-keys-reasoning`)

- **Model picker.** A `role="listbox"` of the three tiers from `/api/v1/models`, then the premium models locked with "Sign in" or "Add your key". A locked row opens Clerk or the keys form instead of selecting. Arrows, Home, End, Enter and Escape work, and focus returns to the trigger. The modes are a radio group at the bottom. WebMCP's `set_model` still works. If the listing fails, the tiers still work.
- **Keys form.** A native modal dialog listing the four providers with the stored key's last four, Replace, Remove and inline 422 errors. The field is cleared before the request leaves, so a key never sits in the page. Tests check the page, the fields and the console, and assert with booleans so a failure cannot print the test key.
- **Reasoning panel.** "Thinking" with a live clock, collapsing to "Thought for Ns" when the answer starts. The thinking is plain text, never copied with the reply, never added to history.
- Screenshots were taken in dark and light, LTR and RTL, at desktop and phone width.

---

## Next

1. **Owner:** merge `feat/visual-pass`, then deploy with `npm run deploy` and `npm run verify-deploy`. This starts the 48-hour report window.
2. Read `/api/csp-report` after 48 hours. Then ask the owner before flipping the main policy to enforcing.
3. **Owner:** merge `feat/m3.6-picker-keys-reasoning` and deploy.
4. The Worker's half of the premium path is now checked offline by `test/gateway-compat.test.ts`. The test confirms that the key goes only into the provider's auth header, through `eleenai-gateway`, uncached and never logged. It also confirms that a missing key stops before any call. The live half is still open: whether the gateway forwards the header and the provider accepts it. The owner is not adding a paid OpenAI or Anthropic key. A free Google AI Studio key would cover it once a Gemini model is listed as a user-key model.
5. Add a production e2e check that allows exactly the two Cloudflare-injected scripts. The existing third-party script test describes our own page and passes locally only.

## DESIGN.md amendments, approved 2026-10-17

- **Layer table, Modals row:** the browser top layer holds Clerk's modals and the keys dialog. Neither sets a `z-index`, and the backdrop is a flat scrim.
- **Model picker:** a "Manage API keys" link under the modes, shown only when signed in.

## Who pays for premium models

A stored key belongs to one user. The chat route looks it up by the caller's own user ID, and the ciphertext is bound to that user and provider. The owner's key, if one is ever added, runs only the owner's own chats. Other users get "Add your key" and must store their own. The gateway holds no provider keys and has "Require provider credentials" on, so a request without a key cannot fall through to the owner's account.
