
// ─── Enhancements ────────────────────────────────────────────────────────────

let currentMode = 'balanced';

document.querySelectorAll('.mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentMode = btn.dataset.mode;
    });
});

document.getElementById('enhance-btn')?.addEventListener('click', async () => {
    const input = document.getElementById('user-input');
    if (!input.value.trim()) return;
    try {
        const res = await fetch('/api/enhance-prompt', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt: input.value }),
        });
        if(res.ok) {
           const { enhanced } = await res.json();
           input.value = enhanced;
           showNotification('✨ Prompt enhanced!');
           // trigger auto-grow
           input.style.height = 'auto';
           input.style.height = (input.scrollHeight) + 'px';
        }
    } catch(e) {
        console.error("Enhance failed", e);
    }
});

/**
 * EleenAI Chat Frontend
 * Supports both authenticated and guest (unauthenticated) users.
 * Features: streaming SSE, markdown rendering, suggestion chips,
 * feedback thumbs, natural-language image generation via [IMG_GEN] tags.
 */

console.log('Chat.js loading...');

// ─── State ───────────────────────────────────────────────────────────────────

let chatHistory = [
    {
        role: "assistant",
        content: "Welcome to the ELEENAI Gateway! I'm your conduit to the realm of artificial intelligence.\nHow may I assist you on this journey?"
    }
];
let isProcessing = false;

// ─── Guest mode ──────────────────────────────────────────────────────────────

// There was a client-side lifetime cap of 15 messages here, counted in
// localStorage. It was removed because it was both stricter than the real
// limit and permanent: the server allows guests 20 chat requests per hour
// (src/lib/ratelimit.ts), keyed on a hashed IP, resetting hourly and
// unbypassable from the browser. The localStorage counter never reset, so a
// visitor who spent 15 messages was locked out forever — and worse, silently:
// sendMessage() returned before making any request, so the page looked healthy
// and simply swallowed the message.
//
// ratelimit.ts puts it best: a limit a client enforces against itself is not a
// limit. The server is the limit; the client just has to report it (see the
// 429 handling in sendMessage).

const GUEST_STORAGE_KEY = 'eleen_guest_msg_count';

// One-shot cleanup. Anyone who hit the old cap still carries the key that
// locked them out, and nothing else would ever clear it.
try {
    localStorage.removeItem(GUEST_STORAGE_KEY);
} catch {
    /* Private mode denies storage access; there is nothing to clean up. */
}

function isAuthenticated() {
    return !!(window.Clerk?.session);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Get the auth token if the user is signed in, otherwise null.
 */
async function getAuthToken() {
    if (!isAuthenticated()) return null;
    try {
        return await window.Clerk.session.getToken();
    } catch (e) {
        console.warn('Could not get Clerk session token:', e);
        return null;
    }
}

/**
 * Build fetch headers. Attaches Bearer token if authenticated.
 */
async function buildHeaders(authenticated) {
    const headers = { 'Content-Type': 'application/json' };
    if (authenticated) {
        const token = await getAuthToken();
        if (token) headers['Authorization'] = `Bearer ${token}`;
    }
    return headers;
}

/**
 * Simple Markdown → HTML parser.
 * Handles code blocks, inline code, bold, italic, links, and bullet lists.
 * Preserves line breaks outside of code blocks.
 */
function parseMarkdown(text) {
    if (!text) return '';

    // Escape HTML to prevent XSS
    let html = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    // Fenced code blocks (```…```)
    html = html.replace(/```(\w*)\n?([\s\S]*?)```/g, (_m, _lang, code) => {
        return `<pre><code>${code}</code></pre>`;
    });

    // Inline code
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

    // Bold (**text**)
    html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

    // Italic (*text*)
    html = html.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>');

    // Markdown links [text](url)
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');

    // Bullet points: wrap consecutive <li> runs in <ul>
    html = html.replace(/^(\s*)-\s+(.*)$/gm, '<li>$2</li>');
    html = html.replace(/((?:<li>.*<\/li>\s*)+)/g, '<ul>$1</ul>');

    // Line breaks: convert \n → <br> *outside* code blocks
    const segments = html.split(/(<pre>[\s\S]*?<\/pre>)/g);
    html = segments.map((seg, i) => {
        if (i % 2 !== 0) return seg; // inside <pre>, leave alone
        return seg.replace(/\n/g, '<br>');
    }).join('');

    // Clean up triple+ <br>
    html = html.replace(/(<br>){3,}/g, '<br><br>');

    return html;
}

/**
 * Regex that matches [IMG_GEN]...[/IMG_GEN] or [IMG_GEN]...[IMG_GEN]
 * (LLMs often forget the slash in the closing tag)
 */
const IMG_GEN_REGEX = /\[IMG_GEN\](.*?)\[\/?IMG_GEN\]/gs;

/**
 * Strip [SUGGEST]…[/SUGGEST] tags from text and return { cleanText, suggestions }.
 */
function extractSuggestions(text) {
    const suggestions = [];
    const cleanText = text.replace(/\[SUGGEST\](.*?)\[\/SUGGEST\]/g, (_m, inner) => {
        inner.split('|').forEach(s => {
            const trimmed = s.trim();
            if (trimmed) suggestions.push(trimmed);
        });
        return '';
    });
    return { cleanText, suggestions };
}

/**
 * Strip [IMG_GEN]…[/IMG_GEN] tags from displayed text so users see clean messages.
 */
function stripImageTags(text) {
    return text.replace(IMG_GEN_REGEX, '').trim();
}

/**
 * Build the final innerHTML for an assistant message bubble,
 * including suggestion chips and feedback thumbs.
 */
function buildAssistantHTML(displayContent, suggestions) {
    let html = `<p>${parseMarkdown(displayContent)}</p>`;

    if (suggestions.length > 0) {
        html += '<div class="suggestion-chips">';
        suggestions.forEach(sug => {
            const safe = sug.replace(/'/g, "\\'").replace(/"/g, '&quot;');
            html += `<button class="suggestion-chip" onclick="handleSuggestionClick('${safe}')">${sug}</button>`;
        });
        html += '</div>';
    }

    html += `
    <div class="message-feedback">
        <button onclick="submitFeedback(this, 'up')" title="Good response"><i class="far fa-thumbs-up"></i></button>
        <button onclick="submitFeedback(this, 'down')" title="Bad response"><i class="far fa-thumbs-down"></i></button>
    </div>`;

    return html;
}

// ─── Suggestion chip click handler ───────────────────────────────────────────

function handleSuggestionClick(text) {
    const input = document.getElementById('user-input');
    if (input) {
        input.value = text;
        document.getElementById('send-button')?.click();
    }
}

// ─── Chat Initialization ────────────────────────────────────────────────────

function initializeChat() {
    console.log('Initializing chat...');

    const sendButton = document.getElementById('send-button');
    const userInput = document.getElementById('user-input');

    if (!sendButton || !userInput) {
        console.error('Required elements not found!');
        return;
    }

    sendButton.addEventListener('click', sendMessage);
    initWheelForwarding();
    console.log('Chat initialized successfully');
}

/**
 * Forward wheel events over the conversation to the scroller.
 *
 * The message area is deliberately click-through in CSS: it is a 52rem column
 * down the middle of the page, and if it claimed pointer events the 3D scene
 * would stop seeing the cursor across that whole band — the model freezes as
 * the pointer crosses it and jumps when it comes out the other side.
 *
 * The cost of that is the wheel, which needs a real event target. This listens
 * on the window instead and scrolls the conversation whenever the pointer is
 * over it, so the scene keeps receiving pointer moves everywhere while the
 * wheel still works where a user expects it to. Anything that scrolls on its
 * own — the composer's textarea, a code block — is left alone.
 */
function initWheelForwarding() {
    const chatMessages = document.getElementById('chat-messages');
    if (!chatMessages) return;

    window.addEventListener('wheel', (event) => {
        // Let an element that can scroll itself handle its own wheel.
        const ownScroller = event.target instanceof Element
            ? event.target.closest('textarea, pre, .message-input')
            : null;
        if (ownScroller) return;

        const box = chatMessages.getBoundingClientRect();
        const over =
            event.clientX >= box.left && event.clientX <= box.right &&
            event.clientY >= box.top && event.clientY <= box.bottom;
        if (!over) return;

        // Nothing to scroll: leave the event alone so the page can use it.
        if (chatMessages.scrollHeight <= chatMessages.clientHeight) return;

        chatMessages.scrollTop += event.deltaY;
        event.preventDefault();
    }, { passive: false });
}

// ─── Rate limit UI ───────────────────────────────────────────────────────────

/**
 * Render the server's 429 as something a person can act on.
 *
 * Previously this fell through to the generic "Sorry, there was an error"
 * bubble, which is indistinguishable from a real fault. Now that the server's
 * hourly allowance is the only limit, it is the message users will actually
 * meet, so it has to say what happened and when to come back.
 */
function showRateLimitMessage(retryAfterSeconds) {
    const chatMessages = document.getElementById('chat-messages');
    if (!chatMessages) return;

    const seconds = Number(retryAfterSeconds);
    let when = 'shortly';
    if (Number.isFinite(seconds) && seconds > 0) {
        const minutes = Math.ceil(seconds / 60);
        when = minutes <= 1 ? 'in about a minute' : `in about ${minutes} minutes`;
    }

    const el = document.createElement('div');
    el.className = 'guest-limit-prompt';
    const p = document.createElement('p');
    const strong = document.createElement('strong');
    strong.textContent = "You've hit the hourly limit";
    p.append(strong, document.createElement('br'));
    p.append(`Please try again ${when}.`);
    el.appendChild(p);
    chatMessages.appendChild(el);

    requestAnimationFrame(() => { stickToBottom(chatMessages, { force: true }); });
}

// ─── Send Message ────────────────────────────────────────────────────────────

async function sendMessage() {
    const userInput = document.getElementById('user-input');
    const sendButton = document.getElementById('send-button');
    const message = userInput.value.trim();

    if (!message || isProcessing) return;

    // No client-side gate: the server's hourly allowance is the limit, and it
    // reports itself via 429 (handled below). Returning early here is what used
    // to swallow messages silently.
    const authenticated = isAuthenticated();

    console.log('Processing message:', message.substring(0, 50) + '...');

    // Lock UI
    isProcessing = true;

    // Show thinking indicator
    const chatMessages = document.getElementById('chat-messages');
    const thinkingEl = document.createElement('div');
    thinkingEl.id = 'thinking-indicator';
    thinkingEl.className = 'thinking-indicator message-enter';
    thinkingEl.innerHTML = `
        <div class="ai-avatar">E</div>
        <div class="thinking-dots">
            <div></div><div></div><div></div>
        </div>
        <div class="thinking-text">Eleen is thinking...</div>
    `;
    chatMessages.appendChild(thinkingEl);
    requestAnimationFrame(() => { stickToBottom(chatMessages, { force: true }); });
    userInput.disabled = true;
    sendButton.disabled = true;

    // Is this a /imagine command?
    const isImageCommand = message.toLowerCase().startsWith('/imagine ');

    try {
        // Show user message
        addMessageToChat('user', message);
        userInput.value = '';
        userInput.style.height = 'auto';

        // Status line, only for image generation. Ordinary replies already show
        // the thinking dots in the message list, and two indicators at once
        // just read as noise.
        const typingIndicator = document.getElementById('typing-indicator');
        if (typingIndicator && isImageCommand) {
            typingIndicator.textContent = '🎨 Generating image...';
            typingIndicator.classList.add('visible');
        }

        // Add to history
        chatHistory.push({ role: 'user', content: message });

        if (isImageCommand) {
            // ─── Image Generation via /imagine ───
            const prompt = message.substring('/imagine '.length).trim();
            const imgEndpoint = authenticated ? '/api/image/generate' : '/api/image/generate/guest';
            const imgHeaders = await buildHeaders(authenticated);

            const response = await fetch(imgEndpoint, {
                method: 'POST',
                headers: imgHeaders,
                body: JSON.stringify({ prompt })
            });

            // Images have their own, much tighter bucket (5/hr for guests), so
            // this can trip well before the chat limit does.
            if (response.status === 429) {
                showRateLimitMessage(response.headers.get('retry-after'));
                return;
            }

            if (!response.ok) throw new Error(`Image generation failed: HTTP ${response.status}`);

            const blob = await response.blob();
            const imageUrl = URL.createObjectURL(blob);
            addImageToChat(imageUrl, prompt);
            chatHistory.push({ role: 'assistant', content: `[Generated image: ${prompt}]` });

        } else {
            // ─── Regular Chat ───
            const endpoint = authenticated ? '/api/chat' : '/api/chat/guest';
            const headers = await buildHeaders(authenticated);

            const response = await fetch(endpoint, {
                method: 'POST',
                headers,
                body: JSON.stringify({ messages: chatHistory })
            });

            if (response.status === 429) {
                showRateLimitMessage(response.headers.get('retry-after'));
                return;
            }

            if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);

            const contentType = response.headers.get('content-type');

            if (contentType?.includes('text/event-stream')) {
                const streamedText = await handleStreamResponse(response);
                await processImageTags(streamedText, authenticated);
            } else {
                const data = await response.json();
                const responseText = data.response || data.choices?.[0]?.message?.content || data.content || 'I received your message.';
                addMessageToChat('assistant', responseText);
                chatHistory.push({ role: 'assistant', content: responseText });
                await processImageTags(responseText, authenticated);
            }
        }

    } catch (error) {
        console.error('Error in sendMessage:', error);
        const errorMessage = error.message?.includes('Failed to fetch')
            ? "Unable to connect to the AI service. Please check your internet connection and try again."
            : "Sorry, there was an error processing your request. Please try again.";
        addMessageToChat('assistant', errorMessage);

    } finally {
        isProcessing = false;
        userInput.disabled = false;
        sendButton.disabled = false;

        // Signals that a turn is fully rendered. WebMCP tools await this
        // instead of polling, since sendMessage resolves before the streamed
        // reply has finished arriving.
        document.dispatchEvent(new CustomEvent('eleen:turn-complete'));

        const typingIndicator = document.getElementById('typing-indicator');
        if (typingIndicator) typingIndicator.classList.remove('visible');

        setTimeout(() => userInput.focus(), 100);

        // Keep history bounded (keep system/first msg + last 19)
        if (chatHistory.length > 20) {
            chatHistory = [chatHistory[0], ...chatHistory.slice(-19)];
        }

    }
}

// ─── Stream Handler ──────────────────────────────────────────────────────────

async function handleStreamResponse(response) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let responseText = '';

    // Create assistant message element. The avatar goes in first so a streamed
    // reply lines up with the grid layout exactly like a non-streamed one.
    const assistantMessageEl = document.createElement('div');
    assistantMessageEl.className = 'message assistant-message';
    assistantMessageEl.innerHTML = '<p></p>';
    assistantMessageEl.prepend(createAvatar());
    document.getElementById('chat-messages').appendChild(assistantMessageEl);
    const assistantTextEl = assistantMessageEl.querySelector('p');

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });

            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;

                const data = line.substring(6).trim();
                if (data === '[DONE]') break;

                try {
                    const json = JSON.parse(data);
                    const content = json.response || json.choices?.[0]?.delta?.content || json.content || '';

                    if (content) {
                        responseText += content;

                        // Strip suggestion and image tags during streaming for cleaner display
                        const { cleanText } = extractSuggestions(responseText);
                        assistantTextEl.innerHTML = parseMarkdown(stripImageTags(cleanText));

                        // Follow the stream, unless the reader has scrolled up
                        stickToBottom(document.getElementById('chat-messages'));
                    }
                } catch (parseError) {
                    console.warn('Failed to parse SSE data:', parseError);
                }
            }
        }
    } finally {
        reader.releaseLock();

        if (responseText.trim()) {
            chatHistory.push({ role: 'assistant', content: responseText });

            // Final render with suggestions and feedback buttons
            const { cleanText, suggestions } = extractSuggestions(responseText);
            assistantMessageEl.innerHTML = buildAssistantHTML(stripImageTags(cleanText), suggestions);
            // innerHTML discarded the avatar node — put it back.
            assistantMessageEl.prepend(createAvatar());

            stickToBottom(document.getElementById('chat-messages'));
        }
    }

    return responseText;
}

// ─── Auto Image Generation from [IMG_GEN] tags ──────────────────────────────

async function processImageTags(text, authenticated) {
    const match = IMG_GEN_REGEX.exec(text);
    IMG_GEN_REGEX.lastIndex = 0; // reset stateful regex
    if (!match) return;

    const imagePrompt = match[1].trim();
    if (!imagePrompt) return;

    console.log(`Auto-generating image from tag: "${imagePrompt}"`);

    const typingIndicator = document.getElementById('typing-indicator');
    if (typingIndicator) {
        typingIndicator.textContent = '🎨 Generating image...';
        typingIndicator.classList.add('visible');
    }

    try {
        const imgEndpoint = authenticated ? '/api/image/generate' : '/api/image/generate/guest';
        const imgHeaders = await buildHeaders(authenticated);

        const response = await fetch(imgEndpoint, {
            method: 'POST',
            headers: imgHeaders,
            body: JSON.stringify({ prompt: imagePrompt })
        });

        if (!response.ok) throw new Error(`Image generation failed: HTTP ${response.status}`);

        const blob = await response.blob();
        const imageUrl = URL.createObjectURL(blob);
        addImageToChat(imageUrl, imagePrompt);

    } catch (error) {
        console.error('Auto image generation failed:', error);
        addMessageToChat('assistant', '⚠️ Image generation failed. Please try again.');
    } finally {
        if (typingIndicator) typingIndicator.classList.remove('visible');
    }
}

// ─── Feedback ────────────────────────────────────────────────────────────────

function submitFeedback(btn, type) {
    const container = btn.parentElement;

    // Reset all buttons in this group
    container.querySelectorAll('button').forEach(b => {
        b.classList.remove('active');
        const icon = b.querySelector('i');
        if (icon) icon.className = icon.className.replace('fas', 'far');
    });

    // Activate clicked button
    btn.classList.add('active');
    const icon = btn.querySelector('i');
    if (icon) icon.className = icon.className.replace('far', 'fas');

    console.log(`Feedback submitted: ${type}`);

    // Inject feedback into local chat history for in-session learning
    for (let i = chatHistory.length - 1; i >= 0; i--) {
        if (chatHistory[i].role === 'assistant') {
            const base = chatHistory[i].content.replace(/\n\n\[User rated this response as: (Good|Bad)\]$/, '');
            const rating = type === 'up' ? 'Good' : 'Bad';
            chatHistory[i].content = base + `\n\n[User rated this response as: ${rating}]`;
            break;
        }
    }
}

// ─── DOM Helpers ─────────────────────────────────────────────────────────────

/**
 * Scroll the message list to the bottom, but only if the reader is already
 * near it. Streaming calls this on every token; without the proximity check,
 * scrolling up to re-read an earlier reply gets yanked back down mid-sentence.
 *
 * Pass force: true after an action the user just took (sending a message),
 * where jumping to the newest content is what they expect.
 */
const STICK_THRESHOLD_PX = 80;

function stickToBottom(el, { force = false } = {}) {
    if (!el) return;

    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (!force && distanceFromBottom > STICK_THRESHOLD_PX) return;

    el.scrollTop = el.scrollHeight;
}

/** Build the gradient "E" avatar that sits in the assistant message gutter. */
function createAvatar() {
    const avatar = document.createElement('div');
    avatar.className = 'ai-avatar';
    avatar.textContent = 'E';
    return avatar;
}

function addMessageToChat(role, content) {
    const chatMessages = document.getElementById('chat-messages');
    if (!chatMessages) return;

    const existingThinking = document.getElementById('thinking-indicator');
    if (existingThinking) existingThinking.remove();

    const messageEl = document.createElement('div');
    messageEl.className = `message ${role}-message message-enter`;
    setTimeout(() => messageEl.classList.remove('message-enter'), 400);

    if (role === 'assistant') {
        const { cleanText, suggestions } = extractSuggestions(content);
        messageEl.innerHTML = buildAssistantHTML(cleanText, suggestions);

        // Prepend after innerHTML — assigning innerHTML would discard the node.
        messageEl.prepend(createAvatar());
    } else {
        // User messages get simple markdown rendering (no feedback/chips)
        messageEl.innerHTML = `<p>${parseMarkdown(content)}</p>`;
    }

    chatMessages.appendChild(messageEl);

    // The user's own message always scrolls into view; a reply only does so if
    // they haven't scrolled away to read something earlier.
    requestAnimationFrame(() => {
        stickToBottom(chatMessages, { force: role === 'user' });
    });
}

function addImageToChat(imageUrl, prompt) {
    const chatMessages = document.getElementById('chat-messages');
    if (!chatMessages) return;

    const messageEl = document.createElement('div');
    messageEl.className = 'message assistant-message';
    messageEl.innerHTML = `
        <div class="chat-image-wrapper">
            <img src="${imageUrl}" alt="${prompt}" class="chat-image" onclick="window.open('${imageUrl}', '_blank')" />
            <p class="chat-image-caption">🎨 <em>${prompt}</em></p>
        </div>
    `;
    chatMessages.appendChild(messageEl);

    requestAnimationFrame(() => {
        stickToBottom(chatMessages);
    });
}

// ─── Clear Chat ──────────────────────────────────────────────────────────────

// `confirm` defaults to true so the button keeps its existing behaviour.
// Programmatic callers (WebMCP tools) pass false: a tool handler must never
// block on a modal dialog, since there is no user present to dismiss it.
function clearChat({ confirm: askFirst = true } = {}) {
    if (askFirst && !confirm('Clear all chat messages?')) return false;

    chatHistory = [
        {
            role: "assistant",
            content: "Chat cleared. How can I help you today?"
        }
    ];

    const chatMessages = document.getElementById('chat-messages');
    if (chatMessages) {
        chatMessages.innerHTML = '';
        addMessageToChat('assistant', chatHistory[0].content);
    }

    console.log('Chat cleared');
    return true;
}

// ─── Public API ──────────────────────────────────────────────────────────────

window.chat = {
    sendMessage,
    clearChat,
    history: () => chatHistory,
    // Lets a programmatic caller wait for a reply instead of polling, and
    // tell "still generating" apart from "finished with an empty answer".
    isProcessing: () => isProcessing
};

// ─── Bootstrap ───────────────────────────────────────────────────────────────

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeChat);
} else {
    initializeChat();
}

console.log('Chat.js loaded');

// ─── Particle System Background ──────────────────────────────────────────────

class Particle {
    constructor(canvas) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        this.reset();
        this.x = Math.random() * canvas.width;
        this.y = Math.random() * canvas.height;
    }

    reset() {
        const colors = ['#6C63FF', '#00E5FF', '#FF6EC7'];
        this.color = colors[Math.floor(Math.random() * colors.length)];
        this.baseRadius = Math.random() * 2 + 1;
        this.radius = this.baseRadius;
        this.baseOpacity = Math.random() * 0.4 + 0.3;
        this.opacity = this.baseOpacity;
        this.speedY = -(Math.random() * 0.5 + 0.1);
        this.speedX = (Math.random() - 0.5) * 0.5;
        this.sineOffset = Math.random() * Math.PI * 2;
        this.pulseTime = Math.random() * 200 + 100;
        this.pulseCounter = 0;
        this.isPulsing = false;

        if(this.y < 0) {
            this.x = Math.random() * this.canvas.width;
            this.y = this.canvas.height + 10;
        }
    }

    update(mouseX, mouseY, isMobile) {
        this.y += this.speedY;
        this.x += this.speedX + Math.sin(Date.now() * 0.001 + this.sineOffset) * 0.2;

        // Parallax
        if (!isMobile && mouseX && mouseY) {
            const dx = (mouseX - this.canvas.width / 2) * 0.02;
            const dy = (mouseY - this.canvas.height / 2) * 0.02;
            this.x += (dx - (this.x - this.canvas.width/2) * 0.001) * 0.1;
            this.y += (dy - (this.y - this.canvas.height/2) * 0.001) * 0.1;
        }

        if (this.y < -10) {
            this.reset();
            this.y = this.canvas.height + 10;
        }
        if (this.x < -10) this.x = this.canvas.width + 10;
        if (this.x > this.canvas.width + 10) this.x = -10;

        // Pulse
        this.pulseCounter++;
        if (this.pulseCounter > this.pulseTime && !this.isPulsing) {
            this.isPulsing = true;
            this.pulseCounter = 0;
        }
        if (this.isPulsing) {
            this.pulseCounter++;
            if (this.pulseCounter < 20) {
                this.radius += 0.3;
            } else if (this.pulseCounter < 40) {
                this.radius -= 0.3;
            } else {
                this.isPulsing = false;
                this.radius = this.baseRadius;
                this.pulseCounter = 0;
                this.pulseTime = Math.random() * 300 + 150;
            }
        }
    }

    draw() {
        this.ctx.globalAlpha = this.opacity;
        this.ctx.fillStyle = this.color;
        this.ctx.beginPath();
        this.ctx.arc(this.x, this.y, Math.max(0.1, this.radius), 0, Math.PI * 2);
        this.ctx.fill();
    }
}

function initParticleSystem() {
    const canvas = document.getElementById('particle-bg');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');

    let isMobile = window.innerWidth < 768;
    let numParticles = isMobile ? 30 : 80;
    let particles = [];
    let mouseX = null;
    let mouseY = null;

    function resize() {
        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;
        isMobile = window.innerWidth < 768;
        numParticles = isMobile ? 30 : 80;
        if(particles.length > numParticles) particles.length = numParticles;
        while(particles.length < numParticles) particles.push(new Particle(canvas));
    }

    window.addEventListener('resize', resize);
    window.addEventListener('mousemove', (e) => {
        mouseX = e.clientX;
        mouseY = e.clientY;
    });

    resize();

    function animate() {
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        particles.forEach(p => {
            p.update(mouseX, mouseY, isMobile);
            p.draw();
        });

        if (!isMobile) {
            ctx.lineWidth = 1;
            for (let i = 0; i < particles.length; i++) {
                for (let j = i + 1; j < particles.length; j++) {
                    const dx = particles[i].x - particles[j].x;
                    const dy = particles[i].y - particles[j].y;
                    const dist = dx * dx + dy * dy;
                    if (dist < 14400) { // 120 * 120
                        const alpha = (1 - dist / 14400) * 0.08;
                        ctx.globalAlpha = alpha;
                        ctx.strokeStyle = '#6C63FF';
                        ctx.beginPath();
                        ctx.moveTo(particles[i].x, particles[i].y);
                        ctx.lineTo(particles[j].x, particles[j].y);
                        ctx.stroke();
                    }
                }
            }
        }

        requestAnimationFrame(animate);
    }

    animate();
}

document.addEventListener('DOMContentLoaded', initParticleSystem);
