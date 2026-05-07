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

// ─── Guest-mode config ───────────────────────────────────────────────────────

const GUEST_MESSAGE_LIMIT = 15;
const GUEST_STORAGE_KEY = 'eleen_guest_msg_count';

function getGuestMessageCount() {
    try {
        return parseInt(localStorage.getItem(GUEST_STORAGE_KEY) || '0', 10);
    } catch {
        return 0;
    }
}

function incrementGuestMessageCount() {
    try {
        const count = getGuestMessageCount() + 1;
        localStorage.setItem(GUEST_STORAGE_KEY, String(count));
        return count;
    } catch {
        return 0;
    }
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
    console.log('Chat initialized successfully');
}

// ─── Guest Limit UI ──────────────────────────────────────────────────────────

function showGuestLimitPrompt() {
    const chatMessages = document.getElementById('chat-messages');
    if (!chatMessages) return;

    const promptEl = document.createElement('div');
    promptEl.className = 'guest-limit-prompt';
    promptEl.innerHTML = `
        <p><strong>✨ You've used all ${GUEST_MESSAGE_LIMIT} free messages!</strong><br>
        Sign in to unlock unlimited conversations and enhanced features.</p>
        <button class="auth-button" onclick="window.Clerk?.openSignIn()">
            <i class="fas fa-sign-in-alt"></i>
            <span>Sign In to Continue</span>
        </button>
    `;
    chatMessages.appendChild(promptEl);

    const userInput = document.getElementById('user-input');
    const sendButton = document.getElementById('send-button');
    if (userInput) {
        userInput.disabled = true;
        userInput.placeholder = 'Sign in to continue chatting...';
    }
    if (sendButton) sendButton.disabled = true;

    requestAnimationFrame(() => {
        chatMessages.scrollTop = chatMessages.scrollHeight;
    });
}

// ─── Send Message ────────────────────────────────────────────────────────────

async function sendMessage() {
    const userInput = document.getElementById('user-input');
    const sendButton = document.getElementById('send-button');
    const message = userInput.value.trim();

    if (!message || isProcessing) return;

    // Check guest limit
    const authenticated = isAuthenticated();
    if (!authenticated && getGuestMessageCount() >= GUEST_MESSAGE_LIMIT) {
        showGuestLimitPrompt();
        return;
    }

    console.log('Processing message:', message.substring(0, 50) + '...');

    // Lock UI
    isProcessing = true;
    userInput.disabled = true;
    sendButton.disabled = true;

    // Is this a /imagine command?
    const isImageCommand = message.toLowerCase().startsWith('/imagine ');

    try {
        // Show user message
        addMessageToChat('user', message);
        userInput.value = '';
        userInput.style.height = 'auto';

        // Show typing indicator
        const typingIndicator = document.getElementById('typing-indicator');
        if (typingIndicator) {
            typingIndicator.textContent = isImageCommand
                ? '🎨 Generating image...'
                : 'Opening gateway to the AI Chat Realm...';
            typingIndicator.classList.add('visible');
        }

        // Add to history
        chatHistory.push({ role: 'user', content: message });

        if (isImageCommand) {
            // ─── Image Generation via /imagine ───
            const prompt = message.substring('/imagine '.length).trim();
            const imgEndpoint = authenticated ? '/api/image/generate' : '/api/image/generate/guest';
            const imgHeaders = await buildHeaders(authenticated);

            if (!authenticated) incrementGuestMessageCount();

            const response = await fetch(imgEndpoint, {
                method: 'POST',
                headers: imgHeaders,
                body: JSON.stringify({ prompt })
            });

            if (!response.ok) throw new Error(`Image generation failed: HTTP ${response.status}`);

            const blob = await response.blob();
            const imageUrl = URL.createObjectURL(blob);
            addImageToChat(imageUrl, prompt);
            chatHistory.push({ role: 'assistant', content: `[Generated image: ${prompt}]` });

        } else {
            // ─── Regular Chat ───
            const endpoint = authenticated ? '/api/chat' : '/api/chat/guest';
            const headers = await buildHeaders(authenticated);

            if (!authenticated) incrementGuestMessageCount();

            const response = await fetch(endpoint, {
                method: 'POST',
                headers,
                body: JSON.stringify({ messages: chatHistory })
            });

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

        const typingIndicator = document.getElementById('typing-indicator');
        if (typingIndicator) typingIndicator.classList.remove('visible');

        setTimeout(() => userInput.focus(), 100);

        // Keep history bounded (keep system/first msg + last 19)
        if (chatHistory.length > 20) {
            chatHistory = [chatHistory[0], ...chatHistory.slice(-19)];
        }

        // Update guest placeholder
        if (!authenticated) {
            const count = getGuestMessageCount();
            if (count >= GUEST_MESSAGE_LIMIT) {
                userInput.placeholder = 'Sign in for unlimited access...';
            } else {
                const remaining = GUEST_MESSAGE_LIMIT - count;
                userInput.placeholder = `Ask me anything... (${remaining} free message${remaining !== 1 ? 's' : ''} left)`;
            }
        }
    }
}

// ─── Stream Handler ──────────────────────────────────────────────────────────

async function handleStreamResponse(response) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let responseText = '';

    // Create assistant message element
    const assistantMessageEl = document.createElement('div');
    assistantMessageEl.className = 'message assistant-message';
    assistantMessageEl.innerHTML = '<p></p>';
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

                        // Strip suggestion tags during streaming for cleaner display
                        const { cleanText } = extractSuggestions(responseText);
                        assistantTextEl.innerHTML = parseMarkdown(cleanText);

                        // Keep scrolled to bottom
                        const chatMessages = document.getElementById('chat-messages');
                        chatMessages.scrollTop = chatMessages.scrollHeight;
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
            assistantMessageEl.innerHTML = buildAssistantHTML(cleanText, suggestions);

            const chatMessages = document.getElementById('chat-messages');
            if (chatMessages) chatMessages.scrollTop = chatMessages.scrollHeight;
        }
    }

    return responseText;
}

// ─── Auto Image Generation from [IMG_GEN] tags ──────────────────────────────

async function processImageTags(text, authenticated) {
    const match = /\[IMG_GEN\](.*?)\[\/IMG_GEN\]/s.exec(text);
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

function addMessageToChat(role, content) {
    const chatMessages = document.getElementById('chat-messages');
    if (!chatMessages) return;

    const messageEl = document.createElement('div');
    messageEl.className = `message ${role}-message`;

    if (role === 'assistant') {
        const { cleanText, suggestions } = extractSuggestions(content);
        messageEl.innerHTML = buildAssistantHTML(cleanText, suggestions);
    } else {
        // User messages get simple markdown rendering (no feedback/chips)
        messageEl.innerHTML = `<p>${parseMarkdown(content)}</p>`;
    }

    chatMessages.appendChild(messageEl);

    requestAnimationFrame(() => {
        chatMessages.scrollTop = chatMessages.scrollHeight;
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
        chatMessages.scrollTop = chatMessages.scrollHeight;
    });
}

// ─── Clear Chat ──────────────────────────────────────────────────────────────

function clearChat() {
    if (confirm('Clear all chat messages?')) {
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
    }
}

// ─── Public API ──────────────────────────────────────────────────────────────

window.chat = {
    sendMessage,
    clearChat,
    history: () => chatHistory
};

// ─── Bootstrap ───────────────────────────────────────────────────────────────

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeChat);
} else {
    initializeChat();
}

console.log('Chat.js loaded');
