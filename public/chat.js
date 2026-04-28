/**
 * EleenAI Chat Frontend
 * Simple, reliable chat functionality
 * Supports both authenticated and guest (unauthenticated) users.
 */

console.log('Chat.js loading...');

// Chat state
let chatHistory = [
    {
        role: "assistant",
        content: "Welcome to the ELEENAI Gateway! I'm your conduit to the realm of artificial intelligence.\nHow may I assist you on this journey?"
    }
];
let isProcessing = false;

// Guest mode config
const GUEST_MESSAGE_LIMIT = 15;
const GUEST_STORAGE_KEY = 'eleen_guest_msg_count';

/**
 * Get guest message count from localStorage
 */
function getGuestMessageCount() {
    try {
        return parseInt(localStorage.getItem(GUEST_STORAGE_KEY) || '0', 10);
    } catch (e) {
        return 0;
    }
}

/**
 * Increment guest message count
 */
function incrementGuestMessageCount() {
    try {
        const count = getGuestMessageCount() + 1;
        localStorage.setItem(GUEST_STORAGE_KEY, String(count));
        return count;
    } catch (e) {
        return 0;
    }
}

/**
 * Check if user is authenticated via Clerk
 */
function isAuthenticated() {
    return !!(window.Clerk?.session);
}

/**
 * Initialize chat
 */
function initializeChat() {
    console.log('Initializing chat...');
    
    const sendButton = document.getElementById('send-button');
    const userInput = document.getElementById('user-input');
    
    if (!sendButton || !userInput) {
        console.error('Required elements not found!');
        return;
    }
    
    // Send button click handler
    sendButton.addEventListener('click', sendMessage);
    
    console.log('Chat initialized successfully');
}

/**
 * Show guest limit reached prompt in the chat
 */
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

    // Disable input
    const userInput = document.getElementById('user-input');
    const sendButton = document.getElementById('send-button');
    if (userInput) {
        userInput.disabled = true;
        userInput.placeholder = 'Sign in to continue chatting...';
    }
    if (sendButton) sendButton.disabled = true;

    // Scroll to bottom
    setTimeout(() => {
        chatMessages.scrollTop = chatMessages.scrollHeight;
    }, 10);
}

/**
 * Send message to API
 */
async function sendMessage() {
    console.log('sendMessage called');
    
    const userInput = document.getElementById('user-input');
    const sendButton = document.getElementById('send-button');
    const message = userInput.value.trim();
    
    // Validate
    if (!message) {
        console.log('Empty message, ignoring');
        return;
    }
    
    if (isProcessing) {
        console.log('Already processing, ignoring');
        return;
    }
    
    // Check guest limit (only for unauthenticated users)
    const authenticated = isAuthenticated();
    if (!authenticated) {
        const guestCount = getGuestMessageCount();
        if (guestCount >= GUEST_MESSAGE_LIMIT) {
            showGuestLimitPrompt();
            return;
        }
    }

    console.log('Processing message:', message.substring(0, 50) + '...');
    
    // Update UI state
    isProcessing = true;
    userInput.disabled = true;
    sendButton.disabled = true;
    
    // Check if this is an image generation command
    const isImageCommand = message.toLowerCase().startsWith('/imagine ');

    try {
        // Add user message to UI
        addMessageToChat('user', message);
        
        // Clear input
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
            // --- IMAGE GENERATION FLOW ---
            const prompt = message.substring('/imagine '.length).trim();
            
            // Determine endpoint based on auth state
            let imgEndpoint = '/api/image/generate';
            const imgHeaders = { 'Content-Type': 'application/json' };

            if (authenticated) {
                try {
                    const authToken = await window.Clerk.session.getToken();
                    if (authToken) {
                        imgHeaders['Authorization'] = `Bearer ${authToken}`;
                    }
                } catch (e) {
                    console.warn('Could not get Clerk session token:', e);
                }
            } else {
                imgEndpoint = '/api/image/generate/guest';
                incrementGuestMessageCount();
            }

            console.log(`Generating image: "${prompt}"`);

            const response = await fetch(imgEndpoint, {
                method: 'POST',
                headers: imgHeaders,
                body: JSON.stringify({ prompt })
            });

            if (!response.ok) {
                throw new Error(`Image generation failed: HTTP ${response.status}`);
            }

            const blob = await response.blob();
            const imageUrl = URL.createObjectURL(blob);
            addImageToChat(imageUrl, prompt);
            chatHistory.push({ role: 'assistant', content: `[Generated image: ${prompt}]` });

        } else {
            // --- REGULAR CHAT FLOW ---
            // Prepare request
            const requestData = {
                messages: chatHistory,
                timestamp: new Date().toISOString()
            };
            
            // Determine endpoint and headers based on auth state
            let endpoint = '/api/chat';
            const headers = {
                'Content-Type': 'application/json'
            };

            if (authenticated) {
                // Authenticated: use the main endpoint with token
                try {
                    const authToken = await window.Clerk.session.getToken();
                    if (authToken) {
                        headers['Authorization'] = `Bearer ${authToken}`;
                    }
                } catch (e) {
                    console.warn('Could not get Clerk session token:', e);
                }
            } else {
                // Guest: use the guest endpoint (no auth required)
                endpoint = '/api/chat/guest';
                // Track guest message count
                incrementGuestMessageCount();
            }
            
            console.log(`Sending request to ${endpoint}`);
            
            // Send request
            const response = await fetch(endpoint, {
                method: 'POST',
                headers: headers,
                body: JSON.stringify(requestData)
            });
        
            console.log('Response status:', response.status);
        
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }
        
            // Handle response
            const contentType = response.headers.get('content-type');
        
            if (contentType && contentType.includes('text/event-stream')) {
                // Handle streaming response
                await handleStreamResponse(response);
            } else {
                // Handle JSON response
                const data = await response.json();
                const responseText = data.response || data.choices?.[0]?.message?.content || data.content || 'I received your message.';
                
                addMessageToChat('assistant', responseText);
                chatHistory.push({ role: 'assistant', content: responseText });
            }
        } // end else (regular chat flow)
    } catch (error) {
        console.error('Error in sendMessage:', error);
        
        // Show error to user
        const errorMessage = error.message.includes('Failed to fetch') 
            ? "Unable to connect to the AI service. Please check your internet connection and try again."
            : "Sorry, there was an error processing your request. Please try again.";
        
        addMessageToChat('assistant', errorMessage);
        
    } finally {
        // Reset UI state
        isProcessing = false;
        userInput.disabled = false;
        sendButton.disabled = false;
        
        // Hide typing indicator
        const typingIndicator = document.getElementById('typing-indicator');
        if (typingIndicator) {
            typingIndicator.classList.remove('visible');
        }
        
        // Focus input
        setTimeout(() => userInput.focus(), 100);
        
        // Limit history
        if (chatHistory.length > 20) {
            chatHistory = [
                chatHistory[0],
                ...chatHistory.slice(-19)
            ];
        }

        // After guest message, check if limit is now reached
        if (!isAuthenticated()) {
            const count = getGuestMessageCount();
            if (count >= GUEST_MESSAGE_LIMIT) {
                // Show remaining count warning on the next interaction
                const userInputEl = document.getElementById('user-input');
                if (userInputEl) {
                    userInputEl.placeholder = 'Sign in for unlimited access...';
                }
            } else {
                const remaining = GUEST_MESSAGE_LIMIT - count;
                const userInputEl = document.getElementById('user-input');
                if (userInputEl) {
                    userInputEl.placeholder = `Ask me anything... (${remaining} free message${remaining !== 1 ? 's' : ''} left)`;
                }
            }
        }
    }
}

/**
 * Handle streaming response
 */
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
            
            if (done) {
                console.log('Stream complete');
                break;
            }
            
            // Decode chunk
            buffer += decoder.decode(value, { stream: true });
            
            // Process lines
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            
            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    const data = line.substring(6).trim();
                    
                    if (data === '[DONE]') {
                        console.log('Received [DONE]');
                        break;
                    }
                    
                    try {
                        const jsonData = JSON.parse(data);
                        const content = jsonData.response || 
                                       jsonData.choices?.[0]?.delta?.content || 
                                       jsonData.content || 
                                       '';
                        
                        if (content) {
                            responseText += content;
                            assistantTextEl.textContent = responseText;
                            
                            // Scroll to bottom
                            const chatMessages = document.getElementById('chat-messages');
                            chatMessages.scrollTop = chatMessages.scrollHeight;
                        }
                    } catch (parseError) {
                        console.warn('Failed to parse SSE data:', parseError, data);
                    }
                }
            }
        }
    } finally {
        reader.releaseLock();
        
        // Add to history
        if (responseText.trim()) {
            chatHistory.push({ role: 'assistant', content: responseText });
            console.log('Added response to history');
        }
    }
}

/**
 * Add message to chat UI
 */
function addMessageToChat(role, content) {
    const chatMessages = document.getElementById('chat-messages');
    
    if (!chatMessages) {
        console.error('Chat messages element not found!');
        return;
    }
    
    const messageEl = document.createElement('div');
    messageEl.className = `message ${role}-message`;
    
    // Format content
    const formattedContent = content
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/\n/g, '<br>');
    
    messageEl.innerHTML = `<p>${formattedContent}</p>`;
    chatMessages.appendChild(messageEl);
    
    // Scroll to bottom
    setTimeout(() => {
        chatMessages.scrollTop = chatMessages.scrollHeight;
    }, 10);
}

/**
 * Add generated image to chat UI
 */
function addImageToChat(imageUrl, prompt) {
    const chatMessages = document.getElementById('chat-messages');
    
    if (!chatMessages) {
        console.error('Chat messages element not found!');
        return;
    }
    
    const messageEl = document.createElement('div');
    messageEl.className = 'message assistant-message';
    messageEl.innerHTML = `
        <div class="chat-image-wrapper">
            <img src="${imageUrl}" alt="${prompt}" class="chat-image" onclick="window.open('${imageUrl}', '_blank')" />
            <p class="chat-image-caption">🎨 <em>${prompt}</em></p>
        </div>
    `;
    chatMessages.appendChild(messageEl);
    
    // Scroll to bottom
    setTimeout(() => {
        chatMessages.scrollTop = chatMessages.scrollHeight;
    }, 10);
}

/**
 * Clear chat history
 */
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

// Export for debugging
window.chat = {
    sendMessage,
    clearChat,
    history: () => chatHistory
};

// Initialize when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeChat);
} else {
    initializeChat();
}

console.log('Chat.js loaded');
