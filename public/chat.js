/**
 * EleenAI Chat Frontend
 * Simple, reliable chat functionality
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
    
    console.log('Processing message:', message.substring(0, 50) + '...');
    
    // Update UI state
    isProcessing = true;
    userInput.disabled = true;
    sendButton.disabled = true;
    
    try {
        // Add user message to UI
        addMessageToChat('user', message);
        
        // Clear input
        userInput.value = '';
        userInput.style.height = 'auto';
        
        // Show typing indicator
        const typingIndicator = document.getElementById('typing-indicator');
        if (typingIndicator) {
            typingIndicator.classList.add('visible');
        }
        
        // Add to history
        chatHistory.push({ role: 'user', content: message });
        
        // Prepare request
        const requestData = {
            messages: chatHistory,
            timestamp: new Date().toISOString()
        };
        
        // Get auth token if available
        const authToken = localStorage.getItem('auth_token');
        
        // Prepare headers
        const headers = {
            'Content-Type': 'application/json'
        };
        
        if (authToken) {
            headers['Authorization'] = `Bearer ${authToken}`;
        }
        
        console.log('Sending request to /api/chat');
        
        // Send request
        const response = await fetch('/api/chat', {
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
