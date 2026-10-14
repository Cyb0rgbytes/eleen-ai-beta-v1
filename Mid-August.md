# EleenAI — Mid-August 2026

**Date:** 2026-08-11
**Repo:** https://github.com/Cyb0rgbytes/eleen-ai-beta-v1 (public)
**Branch:** `feat/agent-readiness`
**Tests:** 41 passing (`npx vitest run`)
**Build:** `npm run check` clean
**Deployed:** Yes — version `1746956f-5b50-45bf-ac8c-53ea48d62454`

Continues from [EndofJuly.md](EndofJuly.md), which remains accurate for everything before this.

---

## What this session did

Two unrelated pieces of work, plus three rounds of fixes found by looking at the deployed site.

1. **The chat UI was rebuilt** into a wide, transparent surface over the Spline scene — the
   Claude/ChatGPT/Gemini shape — replacing the 440px panel pinned to the right edge.
2. **Auth became findable.** There was one small icon pill and *no sign-up control anywhere in the
   codebase*. There are now four controls in two page corners.
3. **`agent_auth` metadata is published**, closing one of the two failing checks at
   isitagentready.com. The DNS-AID runbook was extended to close the other, though publishing the
   records is still a manual action.

Everything below is committed, pushed, deployed, and verified against the live site.

### Commits

```
50d58e9  feat: wide transparent chat surface, and auth you can actually find
c22fa9f  feat: publish agent_auth metadata, and extend the DNS-AID record set
82997e3  fix: restore cursor tracking on the 3D scene, and back the chat messages
bb361a3  fix: tune the scrim and message surfaces against the real 3D scene
45db3fa  fix: keep the scene tracking the cursor across the conversation column
```

8 files, +577 / −83.

---

## The frontend

### Wide and transparent

`.gateway-container` was the whole layout: `max-width: 440px`, `margin: 0 0 0 auto`, a 72%-opaque
fill and a 24px blur. It now spans the page, paints nothing, and holds the conversation to a
**52rem inner reading column** so line lengths stay comfortable at 1920px. That inner column is the
thing Claude, ChatGPT and Gemini all use, and it is what a naive full-bleed panel gets wrong.

The composer picked up the frosted surface the panel used to own — with the shell transparent, it
has to separate from a moving background to stay usable.

### The scrim, and why not a filter

The Spline scene is authored on a **near-white studio backdrop, measured 223,223,223**. Light text
over an unaided transparent surface is unreadable on it.

`903bb1a` had tried solving this by filtering the scene — `invert(1) hue-rotate(180deg)` plus
`mix-blend-mode: screen` — and was reverted seventeen minutes later because it discoloured the
robot. That revert was about the *method*, not the goal.

So the darkening moved off the scene and onto its own layer. `#chat-scrim` sits between the viewer
(z-index 0) and the shell (z-index 2), banded: stronger under the brand bar and the auth pair,
stronger under the composer and footer, softer across the body of the conversation, with a low even
floor. It falls off before the page edges. **The model is never filtered and never tinted.**

The logo carries its own drop-shadow and the footer a text-shadow — a light wordmark that close to
the top edge needs more than the scrim, and the artwork cannot be changed from the repo.

### Auth

Four controls, all opening Clerk modals: **Login** and **Sign up for free** top-right, **Sign in**
and **Sign up for free** bottom-left. Both anchors are fixed to the page corners rather than living
in the header, since the shell is transparent and full width now.

The primary call to action is a flat accent fill, deliberately *not* frosted. On a transparent UI
over a moving scene, the one control that should be findable at a glance has to read as solid.

`#spline-loader` moved to bottom-right to free the corner for the dock.

`updateAuthUI()` keeps sole ownership of every auth control including the three new ones, and every
line enabling `#user-input` and `#send-button` survives on both branches. That function is still
the only code that enables the composer — the `6778bb2` regression path.

### Message contrast

The assistant reply had **no background at all**. That was fine behind a 72%-opaque panel; against
a transparent shell it sat directly on the 3D scene and its contrast changed with whatever the
robot was doing.

Both sides now have surfaces: the assistant a neutral dark panel at 0.88, the user bubble a solid
indigo fill replacing a 0.32 accent tint that was nearly invisible over the bright mid-band. A
multi-paragraph reply renders as **one seamless panel** rather than stacked cards — the paragraph
margin becomes internal padding, since a margin would cut a transparent gap through the fill.

---

## `agent_auth` metadata

`/.well-known/oauth-authorization-server` now exists and carries the block. It did not exist
before, deliberately.

### The conflict, and the call that was made

RFC 8414 §3.3 requires the `issuer` in that document to equal the URL prefix it was fetched from.
Clerk mints the tokens, not EleenAI. This is the identical conflict that made
`/.well-known/openid-configuration` a 307 redirect rather than a synthetic document — the reasoning
is recorded at [wellknown.ts:140-153](src/agent/wellknown.ts#L140-L153).

The difference is that `agent_auth` has nowhere else to go. It describes how agents authenticate to
*EleenAI*, and Clerk's document — the only RFC-conformant place to look — cannot carry a block
about a resource server it knows nothing about.

**Decision:** serve the document with Clerk's issuer, and state the deviation plainly in the file
header in the same form as the openid-configuration note, so a future reader does not "fix" it by
accident.

### Scope: anonymous only

```json
"agent_auth": {
  "skill": "https://eleenai.xyz/auth.md",
  "identity_types_supported": ["anonymous"],
  "anonymous": {
    "credential_types_supported": ["none"],
    "claim_uri": "https://eleenai.xyz/auth.md"
  }
}
```

`anonymous` is not a placeholder — it maps to the `/guest` routes that serve unauthenticated agents
today. `identity_assertion` and `service_auth` are omitted because both need a registration
endpoint, a claim ceremony and a JWT-bearer exchange that does not exist here. Advertising them
would point agents at URLs that 404 — the same failure [openapi.ts:254](src/agent/openapi.ts#L254)
is already criticised for in EndofJuly.md.

### Verified against Clerk, not guessed

The OAuth endpoints were mirrored from Clerk's live document so a client reading EleenAI's copy and
one following `authorization_servers` to Clerk's copy arrive at the same place. That check turned
up `revocation_endpoint` and S256 PKCE support, both now included.

### Wiring

- Route in [router.ts](src/agent/router.ts), beside the protected-resource pair.
- `Link` relation in [links.ts](src/agent/links.ts), propagating to both header constants. It is
  unregistered, like `oauth-protected-resource` and `mcp-server` beside it; the conformance note
  says so.
- `service-meta` entries in the API catalog.
- [auth.md](src/agent/content/auth.md) gains an **Agent registration** section carrying the block —
  the file's first machine-readable content. Its Authorization Server section was corrected: it
  claimed EleenAI serves no discovery document of its own, which is no longer true.

---

## DNS-AID

Documentation only. [docs/dns-aid-records.md](docs/dns-aid-records.md) gains:

- **`_index._agents.eleenai.xyz`**, the entrypoint record scanners probe. The runbook previously
  prescribed only the protocol-specific `_eleenai._mcp` record, so a valid record set still left
  the check failing.
- **`mandatory=alpn,port`** on both records, per RFC 9460 §8 and the draft's own examples.
- **`s=`** on the TXT fallback, pointing at the authorization-server document — the two-hop
  discovery in auth.md needs both hops resolvable from DNS.
- **A resolution of the digest-format ambiguity** the doc left open: the script prints
  `sha256:<hex>`, `sha256sum` prints bare hex, and the SvcParam takes the **bare** form.

**Current `cap-sha256`** (valid until `MCP_SERVER_CARD` changes):

```
753bab6ebad0dbcf67772ec82f70156a69fdc1ffaee38cfa75ac9d558c9956cd
```

---

## Three fixes found only by looking at the deployed page

Each of these passed local testing and was wrong in production. They are recorded because the cause
is structural, not a one-off.

### 1. The robot stopped following the cursor

Making the shell full-width meant its transparent body covered the viewport — and a transparent
element still receives pointer events. It swallowed every mouse move before the Spline canvas could
see it. Hit-testing returned `.chat-container` at every background point, never the viewer.

Fixed with `pointer-events: none` on the shell, handing events back to the regions that need them.

### 2. The scrim was tuned against a backdrop that was not there

**R2 blocks CORS from localhost, so the Spline scene never loads in local dev.** The page renders
on the flat dark `--bg` and everything looks correct. Against the real light studio backdrop the
wordmark was nearly invisible and the footer washed out.

Caught by serving the local stylesheet against the live page, so the real scene rendered behind the
edited scrim. **This is the single most useful technique from this session** — see below.

### 3. The robot followed the cursor, but in jumps

Fix 1 handed pointer events to `#chat-messages` so the wheel would keep working. That scroller is
the 52rem centred column — exactly where the cursor spends most of its time. The shell was
click-through; the scroller inside it was not.

Measured across a sweep of the page:

| | Updates reaching the viewer | Largest dead band |
|---|---|---|
| Before | 24 / 57 | **850px** from x=375 |
| After | 51 / 57 | 175px |

An 850px gap is more than half the screen: the scene held still while the cursor crossed the
middle, then snapped. That was the instability — jumping, not stuttering. Frame pacing was never
the problem (240fps, zero dropped frames).

Events now go to `.message` rather than the scroller, so text selection survives while the gaps
pass through. The wheel is handled by a forwarder in [chat.js](public/chat.js). **Touch is exempt**
— touch scrolling is hit-test driven and the forwarder only covers `wheel`, so a coarse pointer
gives the scroller its events back. Keyed on `(hover: none), (pointer: coarse)` rather than width,
since a narrow desktop window still has a cursor and a large tablet still needs touch.

---

## Things worth remembering

- **Local dev never shows the real Spline backdrop.** R2 blocks CORS from localhost. Any change to
  the scrim, message surfaces, or anything else layered over the scene must be checked against the
  real thing. The technique: route `**/style.css*` to the local file while loading the live page,
  so production's scene renders behind local CSS.
- **`wrangler deploy` uploads the working directory, not a branch.** Pushing does not deploy —
  there is no CI deploy pipeline, only [codeql.yml](.github/workflows/codeql.yml). A deploy run
  from a stale checkout will succeed and publish old code.
- **A Worker-code route is the reliable deploy check.** Static assets can be edge-cached, so old
  HTML/CSS proves nothing. A 404 on a route that exists in source proves the Worker itself is
  stale.
- **A transparent element still receives pointer events.** Twice this session that broke the scene's
  cursor tracking. Anything full-bleed and transparent over the viewer needs `pointer-events: none`.
- **`cap-sha256` covers the served bytes** — `JSON.stringify(card, null, 2)` plus a trailing
  newline — so it must be computed *after* deploying, and recomputed after any `MCP_SERVER_CARD`
  edit including an `API_VERSION` bump. Nothing automated catches the drift.

---

## Still open

Unchanged from EndofJuly.md unless noted.

### Blocking, and outside the repo

- [ ] **Migrate Clerk to a production instance.** The key is still `pk_test_` →
      `feasible-falcon-93.clerk.accounts.dev`, a development instance on a live domain. The four new
      auth buttons render and open modals correctly, but **no visitor can complete a sign-in** until
      the key is swapped. This is the single highest-value manual action.
- [ ] **Enable DNSSEC + DS record at the registrar**, then publish the DNS-AID records. The runbook
      is complete and the digest is above; Cloudflare's guided SVCB form usually needs raw entry mode.
- [ ] **Open the PR.** `main` is now **14 commits behind** — it was 6 at end of July. Production has
      only ever been deployed from `feat/agent-readiness`, and deploying from `main` would still
      reproduce the corrupted-stylesheet bug.
- [ ] **Dependabot: 32 vulnerabilities** (2 critical, 15 high, 12 moderate, 3 low), up from 27.

### Known gaps in the code

- [ ] **KV memory has no notice and no opt-out** while storing name, job, location and preferences
      at a 90-day TTL. Still the most pressing gap; consent work gates anything else that stores data.
- [ ] `/` is served without `charset=utf-8` ([router.ts:74](src/agent/router.ts#L74)) — mojibake in
      toast icons. One-line fix.
- [ ] `currentMode` is never sent to the server, so Balanced/Creative/Logical does nothing
      server-side despite `validateChatBody` accepting it.
- [ ] [openapi.ts:254](src/agent/openapi.ts#L254) still claims conversation history is persisted;
      only a 2KB summarised profile is stored.
- [ ] No `vitest.config.ts`, so `@cloudflare/vitest-pool-workers` is unused and nothing touching
      KV, `Env` or `Request` is testable. The new agent surfaces have **no test coverage**.
- [ ] Four inline `onclick` handlers remain in `chat.js` — CSP is still Report-Only and cannot go
      enforcing until they are delegated listeners.
- [ ] Dead particle system (~140 lines, `#particle-bg` is not in the DOM), and **two** unreferenced
      3.2MB copies of `background.png` — one at the repo root, one in `public/`. The `public/` copy
      is uploaded on every deploy, so deleting it is a real payload win, not just tidying.

### Not started

Phases 3–5 from EndofJuly.md: consent + privacy policy (gates the rest), voice notes, D1 chat
history on the existing unbound `eleen-db`, usage dashboard. Spline deferral is still worth doing —
the viewer runtime is 2.29MB parsed versus 46KB for the scene, and it still loads in `<head>` with
`fetchpriority="high"`.
