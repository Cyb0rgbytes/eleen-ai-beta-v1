# Eleen AI — Implementation Guide
> Repo: `github.com/Cyb0rgbytes/eleen-ai-beta-v1` | Domain: `eleenai.xyz`
> Files to edit: `public/index.html`, `public/chat.js`, `src/index.ts`, `wrangler.jsonc`

---

## Fix 1 — Spline 3D Background

**Files:** `public/index.html`, `src/index.ts`, `wrangler.jsonc`

### Step 1 — Add R2 binding to `wrangler.jsonc`

Add inside the root object:

```jsonc
"r2_buckets": [
  { "binding": "SPLINE_ASSETS", "bucket_name": "spline-assets" }
],
"routes": [
  { "pattern": "eleenai.xyz/*", "zone_name": "eleenai.xyz" },
  { "pattern": "assets.eleenai.xyz/*", "zone_name": "eleenai.xyz" }
]
```

### Step 2 — Add R2 asset route in `src/index.ts`

Add this block **at the very top** of the `fetch` handler, before any other route:

```typescript
const url = new URL(request.url);

if (url.hostname === 'assets.eleenai.xyz') {
  const key = url.pathname.replace(/^\//, '');
  const object = await env.SPLINE_ASSETS.get(key);
  if (!object) return new Response('Not Found', { status: 404 });
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('Cache-Control', 'public, max-age=31536000, immutable');
  headers.set('Access-Control-Allow-Origin', 'https://eleenai.xyz');
  return new Response(object.body, { headers });
}
```

### Step 3 — Replace Spline embed in `public/index.html`

Remove any existing `<spline-viewer>` tag or Spline `<script>` import.

Add this in `<head>`:

```html
<link rel="preconnect" href="https://assets.eleenai.xyz" crossorigin />
```

Add this in `<body>` where the background should sit:

```html
<div id="spline-container" aria-hidden="true">
  <div id="spline-shimmer"></div>
  <canvas id="spline-canvas"></canvas>
</div>
```

### Step 4 — Add CSS for Spline container

Add inside the `<style>` block in `index.html`:

```css
#spline-container {
  position: fixed;
  inset: 0;
  z-index: 0;
  pointer-events: none;
  overflow: hidden;
}
#spline-shimmer {
  position: absolute;
  inset: 0;
  background: linear-gradient(110deg, #0a0a0f 40%, #12121f 50%, #0a0a0f 60%);
  background-size: 200% 100%;
  animation: shimmer 1.6s infinite;
  transition: opacity 0.6s ease;
}
@keyframes shimmer {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}
#spline-canvas {
  width: 100% !important;
  height: 100% !important;
  opacity: 0;
  transition: opacity 0.8s ease;
}
#spline-canvas.loaded { opacity: 1; }
@media (max-width: 480px) { #spline-container { display: none; } }
```

### Step 5 — Add Spline loader script

Add this as the **last script** before `</body>`:

```html
<script type="module">
  async function loadSpline() {
    try {
      const { Application } = await import(
        'https://unpkg.com/@splinetool/runtime@1.9.28/build/runtime.module.js'
      );
      const canvas = document.getElementById('spline-canvas');
      const shimmer = document.getElementById('spline-shimmer');
      const app = new Application(canvas);
      await app.load('https://assets.eleenai.xyz/r_4_x_bot.splinecode');
      canvas.classList.add('loaded');
      shimmer.style.opacity = '0';
      setTimeout(() => shimmer.remove(), 700);
    } catch (err) {
      console.warn('Spline failed, using fallback.', err);
      const shimmer = document.getElementById('spline-shimmer');
      if (shimmer) {
        shimmer.style.animation = 'none';
        shimmer.style.background = '#0a0a0f';
      }
    }
  }
  if ('requestIdleCallback' in window) {
    requestIdleCallback(loadSpline, { timeout: 2000 });
  } else {
    setTimeout(loadSpline, 300);
  }
</script>
```

---

## Feature 1 — Conversation Memory

**Files:** `src/index.ts`, `public/chat.js`

### Backend — `src/index.ts`

Add this constant near the top:

```typescript
const MAX_CONTEXT_MESSAGES = 20;
```

In the `/api/chat` handler, before calling the AI model, slice the messages:

```typescript
const { messages, mode } = await request.json<{ messages: any[]; mode?: string }>();
const contextMessages = messages.slice(-MAX_CONTEXT_MESSAGES);
// use contextMessages when calling env.AI.run(...)
```

### Frontend — `public/chat.js`

Add at module scope (top of file):

```javascript
const conversationHistory = [];
```

When the user sends a message, push it first:

```javascript
conversationHistory.push({ role: 'user', content: userText });
```

After the full streamed response is received, push the assistant reply:

```javascript
conversationHistory.push({ role: 'assistant', content: fullResponse });
```

Send history in every POST body:

```javascript
body: JSON.stringify({ messages: conversationHistory, mode: currentMode })
```

---

## Feature 2 — Reasoning Mode Selector

**Files:** `src/index.ts`, `public/index.html`, `public/chat.js`

### Backend — `src/index.ts`

Replace the existing `SYSTEM_PROMPT` constant with:

```typescript
const BASE_SYSTEM_PROMPT = `You are Eleen, an intelligent and creative AI assistant.
- For factual/logical questions: think step by step before concluding.
- For creative questions: be expressive and original.
- For technical questions: be precise and include examples.
- Never use filler phrases like "Certainly!" or "Of course!".
- Adapt your tone to match the user.`;

const MODE_PREFIX: Record<string, string> = {
  creative: 'PRIORITY: Be maximally creative. Use metaphors, tell stories, generate ideas freely.\n',
  logical:  'PRIORITY: Be rigorous. Use numbered steps. Verify your reasoning.\n',
  balanced: '',
};
```

When building the AI call, construct the final system prompt:

```typescript
const finalPrompt = (MODE_PREFIX[body.mode ?? 'balanced'] ?? '') + BASE_SYSTEM_PROMPT;
```

### Frontend — `public/index.html`

Add above the input box:

```html
<div id="mode-selector">
  <button class="mode-btn active" data-mode="balanced">⚖️ Balanced</button>
  <button class="mode-btn" data-mode="creative">🎨 Creative</button>
  <button class="mode-btn" data-mode="logical">🧠 Logical</button>
</div>
```

### Frontend — `public/chat.js`

Add at module scope:

```javascript
let currentMode = 'balanced';

document.querySelectorAll('.mode-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentMode = btn.dataset.mode;
  });
});
```

---

## Feature 3 — Prompt Enhancer

**Files:** `src/index.ts`, `public/index.html`, `public/chat.js`

### Backend — `src/index.ts`

Add this route inside the `fetch` handler:

```typescript
if (url.pathname === '/api/enhance-prompt' && request.method === 'POST') {
  const { prompt } = await request.json<{ prompt: string }>();
  const result = await env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
    messages: [
      {
        role: 'system',
        content: 'You are a prompt engineer. Rewrite the user prompt to be clearer and more specific. Return ONLY the rewritten prompt — no explanation, no preamble.'
      },
      { role: 'user', content: prompt }
    ],
    max_tokens: 200,
  }) as { response: string };
  return Response.json({ enhanced: result.response });
}
```

### Frontend — `public/index.html`

Add a button next to the send button:

```html
<button id="enhance-btn" title="Enhance prompt">✨</button>
```

### Frontend — `public/chat.js`

```javascript
document.getElementById('enhance-btn').addEventListener('click', async () => {
  const input = document.getElementById('chat-input');
  if (!input.value.trim()) return;
  const res = await fetch('/api/enhance-prompt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: input.value }),
  });
  const { enhanced } = await res.json();
  input.value = enhanced;
  showToast('✨ Prompt enhanced!');
});

function showToast(msg) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 1800);
}
```

---

## Feature 4 — Follow-up Suggestion Chips

**Files:** `src/index.ts`, `public/chat.js`

### Backend — `src/index.ts`

```typescript
if (url.pathname === '/api/suggest-followups' && request.method === 'POST') {
  const { lastUserMessage, lastAssistantMessage } =
    await request.json<{ lastUserMessage: string; lastAssistantMessage: string }>();
  const result = await env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
    messages: [
      {
        role: 'system',
        content: 'Generate exactly 3 short follow-up questions the user might ask next. Return ONLY a JSON array of 3 strings. No markdown, no explanation. Example: ["Q1?","Q2?","Q3?"]'
      },
      {
        role: 'user',
        content: `User: "${lastUserMessage}"\nAssistant: "${lastAssistantMessage.slice(0, 400)}"`
      }
    ],
    max_tokens: 120,
  }) as { response: string };
  try {
    return Response.json({ suggestions: JSON.parse(result.response) });
  } catch {
    return Response.json({ suggestions: [] });
  }
}
```

### Frontend — `public/chat.js`

After a completed AI response, call and render chips:

```javascript
async function renderFollowups(lastUser, lastAssistant) {
  const res = await fetch('/api/suggest-followups', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lastUserMessage: lastUser, lastAssistantMessage: lastAssistant }),
  });
  const { suggestions } = await res.json();
  const container = document.createElement('div');
  container.className = 'followup-chips';
  suggestions.forEach(q => {
    const chip = document.createElement('button');
    chip.className = 'chip';
    chip.textContent = q;
    chip.addEventListener('click', () => {
      document.getElementById('chat-input').value = q;
      container.remove();
      sendMessage();
    });
    container.appendChild(chip);
  });
  document.getElementById('messages-list').appendChild(container);
}
```

Call `renderFollowups(lastUserMsg, fullResponse)` after streaming completes.

---

## Feature 5 — Message Actions (Copy / Regenerate / Read Aloud)

**File:** `public/chat.js`

After rendering each assistant message bubble, append this action bar:

```javascript
function addMessageActions(bubble, messageText) {
  const bar = document.createElement('div');
  bar.className = 'msg-actions';

  // Copy
  const copyBtn = document.createElement('button');
  copyBtn.textContent = '📋 Copy';
  copyBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(messageText);
    copyBtn.textContent = '✓ Copied';
    setTimeout(() => (copyBtn.textContent = '📋 Copy'), 1500);
  });

  // Regenerate
  const regenBtn = document.createElement('button');
  regenBtn.textContent = '🔄 Regenerate';
  regenBtn.addEventListener('click', () => {
    conversationHistory.pop(); // remove last assistant message
    sendMessage(lastUserMessage); // resend last user message
  });

  // Read Aloud
  const readBtn = document.createElement('button');
  readBtn.textContent = '🔊 Read';
  readBtn.addEventListener('click', () => {
    if (speechSynthesis.speaking) {
      speechSynthesis.cancel();
      readBtn.textContent = '🔊 Read';
      return;
    }
    const utterance = new SpeechSynthesisUtterance(messageText);
    utterance.rate = 1.05;
    utterance.onend = () => (readBtn.textContent = '🔊 Read');
    speechSynthesis.speak(utterance);
    readBtn.textContent = '⏹ Stop';
  });

  bar.append(copyBtn, regenBtn, readBtn);
  bubble.appendChild(bar);
}
```

Add CSS in `index.html`:

```css
.msg-actions {
  display: flex;
  gap: 8px;
  margin-top: 6px;
  opacity: 0;
  transition: opacity 0.2s;
}
.msg-actions button {
  font-size: 11px;
  background: none;
  border: none;
  cursor: pointer;
  color: var(--color-text-secondary, #888);
  padding: 2px 6px;
}
.message:hover .msg-actions { opacity: 1; }
```

---

## Deploy

```bash
# Test locally
npm run dev

# Deploy to Cloudflare
npm run deploy

# Verify R2 asset is accessible
curl -I https://assets.eleenai.xyz/r_4_x_bot.splinecode
```

---

## Checklist

- [ ] `wrangler.jsonc` — R2 binding + both routes added
- [ ] `src/index.ts` — R2 asset handler at top of fetch
- [ ] `src/index.ts` — `/api/enhance-prompt` route added
- [ ] `src/index.ts` — `/api/suggest-followups` route added
- [ ] `src/index.ts` — system prompt + mode prefix updated
- [ ] `public/index.html` — old Spline embed removed
- [ ] `public/index.html` — shimmer container + canvas added
- [ ] `public/index.html` — Spline loader script added (last in body)
- [ ] `public/index.html` — mode selector buttons added
- [ ] `public/index.html` — enhance button added
- [ ] `public/chat.js` — conversationHistory array + push logic
- [ ] `public/chat.js` — mode selector wired up
- [ ] `public/chat.js` — enhance button wired up
- [ ] `public/chat.js` — followup chips rendered after each response
- [ ] `public/chat.js` — addMessageActions() called on each assistant bubble
