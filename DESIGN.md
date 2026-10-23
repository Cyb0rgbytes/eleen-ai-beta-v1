# EleenAI design system

**Status:** M0.2, written 2026-10-16. This is the contract the frontend rebuild (M3.5, M3.6, M4.5) builds against. Until the rebuild lands, `web/style.css` is the implementation of the dark theme described here, and anything in that file that disagrees with this document is a bug in the file.

## 1. Design read

EleenAI is a chat product, not a landing page. The interface is a reading column over a live 3D scene, used in two languages, by people who arrive as guests and may sign in. The job of the design is to keep text readable over a moving backdrop, make the few controls that matter findable, and stay out of the conversation's way.

Reading this as: a redesign in **preserve** mode. The brand exists and stays: the indigo accent, the lockup, the Spline robot, the dark-first mood. What changes is rigor, not identity. Every token below is semantic so that a light theme and an RTL layout are configuration, not a second stylesheet.

Reference shape: the Gemini concept in `Concept for UI and interface.png`. Left rail with new-chat and history, gradient greeting, a small set of prompt cards on the empty state, a pill composer with attach and microphone, a one-line disclaimer under it. EleenAI keeps that skeleton and replaces Gemini's flat white with its own scene and surfaces.

Dials, inferred from the read: variance 5, motion 4, density 4. A chat UI is read for minutes at a time, so it earns calm, not spectacle. The scene supplies all the motion the page needs.

## 2. Principles

1. **The scene is never filtered.** No `filter`, no `mix-blend-mode`, no tint on the Spline viewer. Legibility comes from the scrim and the surfaces, never from altering the model. This was tried in August and reverted within the hour.
2. **Transparent means click-through.** Any full-bleed layer above the scene has `pointer-events: none`, and re-enables pointer events only on the elements that need them. Twice in August a transparent element silently swallowed the cursor and the robot stopped tracking.
3. **One reading column.** Conversation text lives in a column no wider than 64rem, centred (52rem until 2026-10-21; widened at the owner's request). Line length stays comfortable at 1920px; the controls stay in the corners.
4. **Semantic tokens only.** Components never name a colour. They name a role: `--surface`, `--text`, `--accent`. Themes and directions change the values, never the components.
5. **Both themes, both directions, from the start.** Every component is checked in dark and light and in LTR and RTL before it ships. Playwright screenshots cover the four combinations (M4.5).
6. **Calm motion.** Transitions use `--ease` at 160 to 320 ms, animate only `transform` and `opacity`, and collapse to instant under `prefers-reduced-motion`. Nothing loops except a live state indicator.
7. **Real states.** Every surface that loads, can be empty, or can fail has a designed loading, empty and error state. A skeleton shaped like the final layout, never a spinner.

## 3. Colour tokens

Defined on `:root`, redefined under `:root[data-theme="light"]`. The initial theme comes from `prefers-color-scheme` and a user's saved choice overrides it, applied by a synchronous script in `<head>` so the page never flashes.

> Amended 2026-10-22 (M4.5): the reader chooses **system**, **light** or **dark** with the theme toggle (section 7); system is the default and follows `prefers-color-scheme` live. `data-theme` on `<html>` always holds the resolved value, `light` or `dark`. The choice is stored in `localStorage` as `eleen.theme` (system is stored as no value) and applied before first paint by `web/public/prefs.js`: a classic, render-blocking, same-origin script, because the CSP forbids inline scripts and the module bundle is deferred, so it could run after the first paint. It is the one script in `web/` that Vite does not bundle; it must stay tiny and must never throw, since storage can be blocked.

### Brand

| Token | Dark | Light | Notes |
|---|---|---|---|
| `--accent` | `#635bf6` | `#5a51f0` | The one accent. Deepened in both themes for 4.5:1 against white text: production's `#6c63ff` measured 4.32:1 under the CTA label (M4.5). Glows and tints keep `rgb(108 99 255)`. |
| `--accent-2` | `#00e5ff` | `#0e7490` | The brand's cyan. Second stop of `--grad` (avatar, active mode pill, greeting), and the focus ring on dark. Deepened on light, where bright cyan fails contrast. |
| `--grad` | `linear-gradient(135deg, var(--accent), var(--accent-2))` | same | The brand gradient. Not used on large surfaces. |
| `--accent-text` | `#00e5ff` | `#4a42d6` | Accent used as text on the base surface: links, inline code, the active picker state. Cyan on dark, as production has always had it. |
| `--accent-soft` | `rgb(108 99 255 / 0.14)` | `rgb(90 81 240 / 0.10)` | Tints: selected chips, hover fills. |
| `--accent-line` | `rgb(108 99 255 / 0.45)` | `rgb(90 81 240 / 0.40)` | Selected and focused borders. |
| `--focus-ring` | `var(--accent-2)` | `var(--accent)` | The 2px keyboard focus outline. |
| `--on-accent` | `#ffffff` | `#ffffff` | Text on a solid accent fill. |

> Amended 2026-10-17: the dark values of `--accent-2`, `--accent-text`, `--assistant-bubble` and `--user-bubble` were transcribed wrong in the first version and now match production, which is what preserve mode intended.

### Surfaces

| Token | Dark | Light | Role |
|---|---|---|---|
| `--bg` | `#07071c` | `#f5f5fb` | Page background behind the scene, shown while the scene loads and when it is skipped. |
| `--bg-deep` | `#030312` | `#e9e9f4` | Sidebar and off-canvas panels. |
| `--surface` | `rgb(11 11 30 / 0.72)` | `rgb(255 255 255 / 0.78)` | Frosted panels over the scene: composer, picker, sidebar cards. Always paired with `backdrop-filter: blur(24px)`. |
| `--surface-solid` | `#0f0f2a` | `#ffffff` | Panels that must not show the scene through them: menus, dialogs, the keys form. |
| `--line` | `rgb(255 255 255 / 0.08)` | `rgb(10 10 40 / 0.08)` | Hairlines and panel borders. |
| `--line-strong` | `rgb(255 255 255 / 0.16)` | `rgb(10 10 40 / 0.16)` | Input borders at rest. |
| `--field` | `rgb(255 255 255 / 0.04)` | `rgb(10 10 40 / 0.03)` | Input fills. |
| `--assistant-bubble` | `rgb(9 9 26 / 0.88)` | `rgb(255 255 255 / 0.90)` | Assistant reply surface. Opaque enough that contrast does not depend on what the robot is doing behind it. |
| `--user-bubble` | `linear-gradient(135deg, rgb(78 70 200 / 0.92), rgb(58 52 165 / 0.92))` | `#5a51f0` | User turn. Near-solid in both themes; a light tint was invisible over the scene's bright band. |
| `--user-bubble-line` | `rgb(140 132 255 / 0.5)` | `transparent` | User bubble border. |

### Text

| Token | Dark | Light |
|---|---|---|
| `--text` | `#e8e8ff` | `#16163a` |
| `--text-dim` | `#a8a8d8` | `#4a4a74` |
| `--text-faint` | `#8a8aba` | `#66668a` |
| `--on-user-bubble` | `#e8e8ff` | `#ffffff` |

### Status

Status colours exist only for real state. No decorative dots.

| Token | Dark | Light |
|---|---|---|
| `--ok` | `#4ade80` | `#15803d` |
| `--warn` | `#fbbf24` | `#a14a07` |
| `--danger` | `#f87171` | `#b91c1c` |
| `--recording` | `#f87171` | `#dc2626` |

### The scrim

`#chat-scrim` sits between the scene and the shell and darkens (dark theme) or lightens (light theme) only the regions the conversation occupies: stronger under the brand bar and the auth pair, stronger under the composer and footer, softer across the body, with a low even floor. It falls off before the page edges so the robot stays visible at full strength at the sides.

The scrim is four layered gradients in one colour, `--scrim-rgb`, at different strengths. Dark values are production's, measured against the live scene in August.

| Token | Dark | Light | Band |
|---|---|---|---|
| `--scrim-rgb` | `3 3 18` | `245 245 251` | The colour, as channels for `rgb(var(--scrim-rgb) / a)` |
| `--scrim-top` | `0.72` | `0.60` | Under the brand bar and auth pair, fading by 26% of height |
| `--scrim-bottom` | `0.78` | `0.66` | Under the composer and footer, fading by 30% |
| `--scrim-body` | `0.42` | `0.34` | Ellipse behind the conversation, falling off before the edges |
| `--scrim-floor-a`, `--scrim-floor-b` | `0.22`, `0.30` | `0.16`, `0.22` | Even floor, top to bottom |

The scene's studio backdrop measures `223,223,223`. In light theme the scrim is nearly the same value, so light mode is the one where the scene needs the least help; in dark theme the scrim carries the whole contrast load. Check every change to the scrim against the live scene, never against local dev, where the scene does not load.

### Contrast floor

Body text 4.5:1 against its surface in both themes. The wordmark and the footer carry their own shadows because they sit near the page edge where the scrim has fallen off.

> Amended 2026-10-22 (M4.5 audit). Measured against the worst plausible composite of each translucent surface over the bright scene (`#232332` dark, `#f0f0f6` light), these failed and were fixed in tokens only: `--text-faint` (3.1:1 dark, 3.4:1 light), white on `--accent` in dark (4.32:1), `--warn` and `--tok-number` on light (4.4:1), `--tok-comment` in both themes (4.2:1), and the light `--mode-active` gradient, whose 0.8-alpha cyan end left its white label at 3.7:1 (now opaque stops). `--accent-hover` now deepens instead of brightening, so hovering never drops a label below the floor. The lockup's wordmark is white artwork, so on light `--logo-shadow` is a dark outline; a light shadow made it disappear. A dark-ink lockup asset would be the better fix.

Known exception: the Send button's white glyph on `--grad` is under 3:1 where the gradient turns cyan. It is a brand surface, kept as production has it, and flagged for the owner.

## 4. Typography

Three families, self-hosted from `/fonts/` as WOFF2 with `font-display: swap` (M3.5).

| Role | Family | Why |
|---|---|---|
| Latin UI and body | **Inter** | Already the brand's face. Kept under preserve mode; its neutrality suits a reading surface. |
| Arabic UI and body | **Noto Sans Arabic** | Metrics sit well beside Inter, full weight range, correct shaping for Gulf and Levantine text. Its `@font-face` is scoped by `unicode-range` to Arabic code points, so the browser fetches it only when Arabic text renders, in either UI language. An English-only session never downloads it. |
| Code | **JetBrains Mono** | Already in use. Code blocks, inline code, token counts. |

Font stacks:

```css
--font-sans: "Inter", "Noto Sans Arabic", "Segoe UI", system-ui, -apple-system, sans-serif;
--font-mono: "JetBrains Mono", ui-monospace, SFMono-Regular, Consolas, monospace;
```

Arabic is listed in the sans stack so mixed-script lines fall through correctly without per-span rules.

### Scale

A 1.2 ratio from a 16px base, in rem. Arabic renders slightly small at the same size, so `html[lang="ar"]` sets `--text-scale: 1.06` and every size below multiplies by it.

| Token | Size | Line height | Use |
|---|---|---|---|
| `--fs-xs` | 0.75rem | 1.4 | Timestamps, usage counts, footer |
| `--fs-sm` | 0.875rem | 1.5 | Secondary labels, chips, picker entries |
| `--fs-md` | 1rem | 1.65 | Conversation body |
| `--fs-lg` | 1.25rem | 1.4 | Section titles in the sidebar and settings |
| `--fs-xl` | 1.75rem | 1.25 | Empty-state greeting on small screens |
| `--fs-2xl` | 2.5rem | 1.15 | Empty-state greeting on desktop |

Weights: 400 body, 500 labels and buttons, 600 titles. Nothing heavier. Hierarchy comes from colour and weight, not size. The greeting is the only place the brand gradient is used as text, and it is a single short line.

Conversation body: `--fs-md`, `--text`, max 72ch inside the 64rem column. Paragraph spacing 0.75em. Assistant replies render as one continuous panel; paragraph margins become internal padding so a transparent gap never cuts the fill.

## 5. Layer contract

Fixed z-indexes. Nothing else on the page sets `z-index`.

| Layer | `z-index` | Element | Pointer events |
|---|---|---|---|
| Scene | 0 | `#spline-bg` | receives everything that falls through |
| Scrim | 1 | `#chat-scrim` | none |
| Shell | 2 | `.gateway-container` | none on the shell; re-enabled on `.message`, the composer, the brand bar, the picker |
| Loader | 3 | `#spline-loader` | none |
| Auth | 4 | `.auth-container`, `.auth-dock` | auto |
| Sidebar | 5 | `#sidebar` and its off-canvas scrim | auto |
| Toasts | 1000 | `#auth-notification`, toasts | none, except a dismiss button |
| Modals | browser top layer, no `z-index` | Clerk's modals, the keys dialog, the consent dialog and the memory-and-privacy panel (each a native `<dialog>` opened with `showModal()`) | auto; the backdrop is a flat scrim, never a blur |

### The pointer-events rule

A transparent element still receives pointer events. Every layer above the scene that spans the viewport is `pointer-events: none`, and only the controls inside it opt back in. The conversation scroller opts in, so the browser scrolls it natively in every browser. The robot still sees the cursor everywhere: `web/src/scene/spline.ts` re-sends every mouse move over the page's own elements to the Spline canvas. Amended 2026-10-21. Before that, the column was click-through and a script forwarded the wheel, which lagged, barely moved in Firefox (line-mode deltas), and still froze the robot over the prompt cards and composer.

Measured in August: before this rule the robot missed 24 of 57 cursor updates with an 850px dead band across the middle of the screen; after it, 51 of 57 with a 175px band.

## 6. Right-to-left

Arabic is a first-class direction, not a flipped afterthought.

- The language toggle sets `lang` and `dir` on `<html>`. Nothing else is needed for layout to mirror, because:
- The choice is stored as `eleen.lang` and applied before first paint by the same `prefs.js` as the theme. Switching reloads the page: strings are set once by each module as it builds its controls, and a half-translated page is worse than a reload. A reload starts a new conversation, so when one is under way the reader is asked first (M4.5).
- **Logical properties only.** `margin-inline-start`, `padding-inline`, `inset-inline-end`, `border-start-start-radius`, `text-align: start`. No `left`, `right`, `margin-left`, `text-align: left` anywhere in component CSS. Physical properties are allowed only for things that are genuinely physical: the scrim bands, which follow the scene, the body's backdrop glows, and the Spline canvas. Code blocks are LTR in every direction, so their own padding and alignment may be physical. `object-position` has no logical keywords, so the logo's anchoring takes an explicit `[dir="rtl"]` rule. Transforms are physical too: anything that moves toward an inline side multiplies by `--dir-sign` (1 in LTR, -1 in RTL), as the user-turn entrance, toasts, chip arrows, the composer sweep and the skeleton sheen do.
- **Bubbles use `dir="auto"`.** A user writing Arabic in an English session gets a correctly aligned bubble, and vice versa. Code blocks are always `dir="ltr"`.
- **Icons that imply direction mirror.** Send arrow, back, chevrons on the branch navigator, the sidebar collapse control. Icons that do not imply direction do not mirror: microphone, attach, search, settings, the model-tier marks.
- **Numbers stay Western Arabic digits** by default; `html[lang="ar"]` may opt into `font-variant-numeric` and Eastern digits through a user setting later. Not in scope now.
- **The user bubble sits at `inset-inline-end`** and the assistant panel at `inset-inline-start`, so the conversation mirrors as a whole.
- **Punctuation in Arabic UI strings** comes from the i18n file, never concatenated in code.

Checked by screenshot in all four combinations: dark LTR, dark RTL, light LTR, light RTL.

## 7. Components

### Shell and empty state

Full-width transparent shell, 64rem reading column. The logo is 50px tall on desktop, 40px at 768px and below, 34px at 400px. The empty state shows a greeting in `--fs-2xl` with the brand gradient on the first line, a one-line subtitle in `--text-dim`, and exactly as many prompt cards as there are prompts, never a blank cell. Cards are `--surface` with `--line` borders at `--r-md`. Three or four cards on desktop, a horizontal scroll-snap row on mobile.

### Theme and language toggles (M4.5)

Two ghost buttons at the inline-start of the auth plate in the page corner, before the sign-in pair, separated from it by a `--line` divider; the plate is never empty, so they are reachable in every auth state, including when Clerk is unavailable. The theme toggle is icon-only (monitor, sun, moon for system, light, dark), cycles system, light, dark, and is named by a visually hidden label ("Theme: light"). The language toggle shows the other language's own name in that language (`العربية` or `English`, with a matching `lang`) beside a translate glyph; that text is its accessible name. On phones the name is visually hidden and the glyph remains. Both are 44px on coarse pointers. The theme glyph pops in with the icon swap; colours never animate.

### Composer

A pill, `--surface` with `blur(24px)`, `--r-pill`. From inline-start: attach, the text area, microphone, send. Send is a solid `--accent` circle; it is the one control on the page that must read as solid at a glance. The mode pills (Balanced, Creative, Logical) move from above the field into the picker popover. The enhance action stays as an icon inside the pill.

Focus ring: 2px `--accent-line` outside the pill.

Light and glow (amended 2026-10-21, owner's request): the composer carries a soft brand glow (`--glow-composer`), and its focus ring carries a stronger one (`--glow-composer-focus`) that blooms in with the ring. While a reply streams, a band of light (`--sweep`) runs along the composer's top edge. The assistant avatar glows (`--glow-avatar`), and its halo breathes while a reply thinks, arrives or is read aloud. Glows are static shadows from tokens; anything that fades does so on its own layer's opacity. The scene is never lit, filtered or tinted.

The composer also holds the spoken-replies toggle (when I speak, always, off) beside the enhance action.

Disabled: 50% opacity, no pointer. Recording: microphone fills `--recording`, a timer and a live level waveform from the microphone stream appear inline, Escape cancels.

While a reply streams, Send becomes **Stop**: the same `--accent` circle with a stop glyph and the label "Stop generating". Pressing it aborts the request; the text received so far stays in the panel, marked as stopped.

### Model picker (M3.6)

A trigger in the composer's leading edge shows the current tier name with a small chevron. Opening it reveals a popover anchored to the trigger, `--surface-solid`, `--r-md`, listing the three tiers from `/api/v1/models`:

| Row | Content |
|---|---|
| Fast | Label, one-line description, the owner-billed model's short name |
| Smart | Same |
| Reasoning | Same, with a note that it thinks before answering |

Then a divider and the premium models, each with a lock mark and its `access` reason in `--text-faint`: "Sign in", or "Add your key". A guest tapping a locked row gets the sign-in modal; a signed-in user gets the keys form. Selected row has `--accent-soft` fill and `--accent-text` label. The mode pills sit at the bottom of the same popover as a segmented control. Under them, for signed-in users only, a "Manage API keys" link in `--accent-text` opens the keys form, so it is reachable without a locked row.

Keyboard: arrow keys move, Enter selects, Escape closes, focus returns to the trigger. The popover is `role="listbox"`.

### Reasoning panel (M3.6)

Only on the v2 stream, only when a `reasoning` event arrives. A collapsible row at the top of the assistant panel: a small disclosure chevron, the label "Thinking", and a live duration in `--fs-xs` while reasoning streams. Collapsed by default once the answer begins; expands to show the thinking in `--text-dim` at `--fs-sm` with `--line` to its inline-start. The label changes to "Thought for 12s" when done. Never shown for the v1 stream.

### Assistant and user turns

Assistant: `--assistant-bubble`, `--r-lg`, a small "E" avatar at the inline-start, actions (copy, regenerate, feedback) revealed on hover or focus in a row under the text. User: `--user-bubble`, `--on-user-bubble`, `--r-lg` with the trailing corner at `--r-sm`, aligned to `inset-inline-end`, max 75% of the column.

Streaming: the newest token is appended without a caret animation; a 1px `--accent-line` rule on the panel's inline-start edge pulses only while tokens arrive, and stops. Under reduced motion it is static.

Usage: on the v2 stream, the actions row ends with the output token count in `--fs-xs` `--text-faint` ("212 tokens"). Not shown for v1.

### Compare (M5.4)

A "Compare" ghost button in the composer's controls row, after the picker, opens a `--surface-solid` dialog (the keys form's shell) listing the models as checkboxes: two or three may be chosen, locked ones show their reason and cannot be. While on, the button reads "Compare 3", is pressed, and carries `--accent-text` on `--accent-soft`. Guests get the sign-in modal.

A compare turn is one group in the column: a small head ("Answers from 3 models", then the navigator, which counts the whole group as one version), then one lane per model. From 1024px the lanes are equal columns and the tabs hide; below, a pill tab row shows one lane at a time. Each lane is headed by its model's name and holds an ordinary reply panel without the avatar, with Copy, Speak and usage but no Regenerate or rating. The lane the thread continues from has an `--accent-line` border and "Continuing from this answer"; the others offer "Continue with this answer". Each lane waits on its own skeleton lines and ends on its own (complete, stopped or error).

### Jump to latest

A pill, `--surface-solid` with a `--line` border and `--r-pill`, centred above the composer. It appears when the user has scrolled more than 160px up from the bottom while a reply is streaming, reads "Jump to latest" with a down arrow, and scrolls to the end on click or Enter. It hides when the user is back within the stick threshold.

### Sidebar (M4.4)

Off-canvas on viewports under 1024px, pinned at 280px above. `--bg-deep` fill, since it should not show the scene through it. Sections: New chat, Pinned, Folders, Recent, and a search field at the top. Items are single-line with `text-overflow: ellipsis`; the active item has `--accent-soft`. The toggle lives at the top inline-start corner and mirrors in RTL. The sidebar never covers the composer on desktop.

### Keys form (M3.6)

The UI for `/api/v1/keys`, which shipped in M3.4 part two.

A `--surface-solid` dialog listing the four providers. Each row: provider name, a masked field showing the stored key's last four, a Replace action and a Remove action. Adding a key shows one field with a label above it, inline validation below it on 422, and a success state that shows the last four. No placeholder-as-label.

### Toasts

Bottom inline-end, `--surface-solid`, one line, auto-dismiss at 4s with a visible dismiss control. Icons from the inline SVG set, never emoji glyphs; the mojibake incident came from a `charset` header, but emoji in UI strings is not worth the risk in either case.

## 8. Motion

- `--ease: cubic-bezier(0.16, 1, 0.3, 1)`, durations 160 ms for state changes, 240 ms for reveals, 320 ms for the sidebar and popovers.
- Animate `transform` and `opacity` only. No springs: every motion uses `--ease`, so the page has one feel.
- Entrances, all 240 ms on `--ease`:
  - User turn: opacity from 0 and `translateX(12px)` toward the inline-end side, so it arrives from the side it lives on.
  - Assistant panel: opacity from 0 and `translateY(8px)`.
  - Empty-state greeting and prompt cards: same rise, staggered 40 ms per element.
- Prompt card hover: `translateY(-2px)`, the border moves to `--accent-line`, and `--glow-card-hover` fades in on the card's own layer.
- `@media (prefers-reduced-motion: reduce)` sets every transition to `0ms` and removes the streaming pulse, the composer sweep and the avatar halo.
- The scene itself is the motion layer. On `prefers-reduced-motion`, `saveData`, under four cores, or on a coarse pointer, the scene is skipped and a static WebP poster of the robot takes its place at `z-index: 0` (M5.5).

## 9. Accessibility floor

- All text 4.5:1 against its surface in both themes; large text 3:1.
- Every interactive element reachable by keyboard, with a visible 2px `--accent-line` focus ring. Never `outline: none` without a replacement.
- Live regions: the conversation scroller is `aria-live="polite"` for new assistant text; toasts are `role="status"`.
- Buttons have text labels, even when visually icon-only, via a visually hidden span.
- Touch targets at least 44px on coarse pointers.
- The scene is `aria-hidden`.

### Rendering model output

Model output is attacker-influenced: a prompt injection in a document or search result can make the model write anything. So:

- Our code has **no HTML sinks**. Markdown is tokenised and turned into DOM nodes from an allowlist of elements and attributes. Raw HTML in a reply renders as text.
- Links pass a scheme allowlist (`http`, `https`, `mailto`) and open with `rel="noopener noreferrer nofollow"` and `target="_blank"`.
- Markdown images never render as `<img>`. A model-written image URL is the classic exfiltration channel; it is shown as a link instead.
- GitHub-style alerts (`> [!TIP]`, `[!NOTE]`, `[!IMPORTANT]`, `[!WARNING]`) render as `aside.callout`. The kind comes from that fixed list, and each takes one status or brand token.
- A finished code block gets a header with its language and a Copy button. Syntax colours come from Prism, loaded on first use in its own chunk and used only as a tokenizer: tokens become `span.tok-*` elements whose text is set with `textContent`.
- While a reply streams, newly arrived text fades in (opacity only, 350 ms). The finished reply carries no fade spans.
- Trusted Types runs in a Report-Only header. Our code would pass enforcement; Clerk and the Spline viewer may not, and enforcing on their behalf would mean a permissive default policy.

## 10. What we deliberately do not do

- No filters or tints on the scene.
- No `z-index` outside the layer table.
- No physical direction properties in component CSS.
- No colour named directly in a component.
- No decorative dots, no infinite animations except live states: recording, streaming (the rule and the composer sweep), and a reply thinking or being read aloud (the avatar halo).
- No emoji in UI strings.
- No new accent colour. One accent, both themes.
- No `h-screen`. Full-height layouts use `100dvh`.

## 11. Tooling

- Tokens live in `web/style.css` today and move to `web/src/styles/tokens.css` with the TypeScript frontend (M3.5). The light theme is the first consumer of the token file and is the acceptance test that no component names a colour.
- The frontend builds with Vite from `web/` into `dist/`, which the Worker serves. `web/public/` holds files copied verbatim: the classic `chat.js` and `webmcp.js` scripts, the logo, `robots.txt`.
- Playwright end-to-end tests live in `e2e/`. The smoke suite runs against a local `wrangler dev`; the screenshot suite (M4.5) runs against production with local CSS routed in, so the real scene renders behind the change under review.
- Amended 2026-10-22: `e2e/theme.spec.ts` is that suite's first part. It runs locally under reduced motion (the poster stands in for the scene), loads a mocked conversation in all four combinations, asserts the resolved tokens, `dir`, `lang`, the mirrored layout and the toggles' persistence, and saves `test-results/theme/{dark,light}-{ltr,rtl}.png` plus two phone shots for review. They are not pixel baselines; the scene moves.
- Lighthouse before and after the Spline deferral (M5.5), with LCP as the headline number.
