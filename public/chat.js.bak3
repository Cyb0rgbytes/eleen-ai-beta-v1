/**
 * EleenAI Chat Frontend
 * 
 * Handles chat UI interactions and communication with backend API.
 * Works with or without authentication.
 */

// DOM elements
const chatMessages = document.getElementById("chat-messages");
const userInput = document.getElementById("user-input");
const sendButton = document.getElementById("send-button");
const typingIndicator = document.getElementById("typing-indicator");

// Chat state
let chatHistory = [
    {
        role: "assistant",
        content: "Welcome to the ELEENAI Gateway! I'm your conduit to the realm of artificial intelligence. How may I assist you on this journey?\n\n✨ You can start chatting right away, or login for enhanced features!"
    },
];
let isProcessing = false;

// Initialize chat when page loads
document.addEventListener('DOMContentLoaded', () => {
    initializeChat();
});

/**
 * Initialize chat functionality
 */
function initializeChat() {
    // Auto-resize textarea as user types
    userInput.addEventListener("input", function () {
        this.style.height = "auto";
        this.style.height = this.scrollHeight + "px";
    });

    // Send message on Enter (without Shift)
    userInput.addEventListener("keydown", function (e) {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
    });

    // Send button click handler
    sendButton.addEventListener("click", sendMessage);

    // Clear button (optional, add to UI if needed)
    const clearButton = document.createElement('button');
    clearButton.id = 'clear-chat';
    clearButton.innerHTML = '<i class="fas fa-trash-alt"></i> Clear';
    clearButton.style.cssText = `
        position: absolute;
        top: 1rem;
        left: 1rem;
        background: rgba(138, 43, 226, 0.2);
        border: 1px solid rgba(138, 43, 226, 0.4);
        color: var(--text-color);
        padding: 0.5rem 1rem;
        border-radius: 20px;
        cursor: pointer;
        font-size: 0.9rem;
        backdrop-filter: blur(10px);
        display: flex;
        align-items: center;
        gap: 0.5rem;
        z-index: 10;
    `;
    clearButton.addEventListener('click', clearChat);
    document.querySelector('.chat-container').appendChild(clearButton);
}

/**
 * Get authentication token if available
 */
async function getAuthToken() {
    try {
        const token = localStorage.getItem('auth_token');
        if (token) {
            // Basic token validation
            try {
                const payload = JSON.parse(atob(token.split('.')[1]));
                const now = Math.floor(Date.now() / 1000);
                if (payload.exp && payload.exp > now) {
                    return token;
                } else {
                    console.log('Token expired');
                    localStorage.removeItem('auth_token');
                    // Try to refresh token if auth0 client exists
                    if (window.auth0Client) {
                        try {
                            const newToken = await window.auth0Client.getTokenSilently();
                            localStorage.setItem('auth_token', newToken);
                            return newToken;
                        } catch (refreshError) {
                            console.warn('Could not refresh token:', refreshError);
                        }
                    }
                }
            } catch (e) {
                console.warn('Invalid token format');
                localStorage.removeItem('auth_token');
            }
        }
        return null;
    } catch (error) {
        console.error('Error getting auth token:', error);
        return null;
    }
}

/**
 * Get user info from token
 */
async function getUserInfo() {
    try {
        const token = await getAuthToken();
        if (token) {
            const payload = JSON.parse(atob(token.split('.')[1]));
            return {
                id: payload.sub,
                email: payload.email,
                name: payload.name
            };
        }
    } catch (error) {
        console.error('Error getting user info:', error);
    }
    return null;
}

/**
 * Send message to backend API
 */
async function sendMessage() {
    const message = userInput.value.trim();

    // Don't send empty messages
    if (message === "" || isProcessing) return;

    // Disable input while processing
    isProcessing = true;
    userInput.disabled = true;
    sendButton.disabled = true;

    // Add user message to chat
    addMessageToChat("user", message);

    // Clear input
    userInput.value = "";
    userInput.style.height = "auto";

    // Show typing indicator
    typingIndicator.classList.add("visible");

    // Add message to history
    chatHistory.push({ role: "user", content: message });

    try {
        // Create new assistant response element
        const assistantMessageEl = document.createElement("div");
        assistantMessageEl.className = "message assistant-message";
        assistantMessageEl.innerHTML = "<p></p>";
        chatMessages.appendChild(assistantMessageEl);
        const assistantTextEl = assistantMessageEl.querySelector("p");

        // Scroll to bottom
        chatMessages.scrollTop = chatMessages.scrollHeight;

        // Get auth token if available
        const token = await getAuthToken();
        const userInfo = await getUserInfo();

        // Prepare request headers
        const headers = {
            "Content-Type": "application/json"
        };

        // Add auth header if token exists
        if (token) {
            headers["Authorization"] = `Bearer ${token}`;
        }

        // Prepare request body
        const requestBody = {
            messages: chatHistory,
            timestamp: new Date().toISOString(),
            user_agent: navigator.userAgent
        };

        // Add user info if available
        if (userInfo) {
            requestBody.user_id = userInfo.id;
            requestBody.user_email = userInfo.email;
        }

        // Send request to API
        const response = await fetch("/api/chat", {
            method: "POST",
            headers: headers,
            body: JSON.stringify(requestBody),
        });

        // Handle authentication errors
        if (response.status === 401) {
            // Token expired or invalid
            localStorage.removeItem('auth_token');
            // Retry without auth token
            return await retryRequestWithoutAuth(requestBody);
        }

        // Handle other errors
        if (!response.ok) {
            throw new Error(`API Error: ${response.status}`);
        }

        if (!response.body) {
            throw new Error("No response body");
        }

        // Process streaming response
        await processStreamResponse(response, assistantTextEl);

    } catch (error) {
        console.error("Chat error:", error);
        handleChatError(error);
    } finally {
        // Clean up
        typingIndicator.classList.remove("visible");
        isProcessing = false;
        userInput.disabled = false;
        sendButton.disabled = false;
        
        // Re-focus input
        setTimeout(() => userInput.focus(), 100);
        
        // Limit chat history (keep last 15 messages + initial greeting)
        if (chatHistory.length > 16) {
            chatHistory = [
                chatHistory[0], // Keep initial greeting
                ...chatHistory.slice(-15) // Keep last 15 messages
            ];
        }
    }
}

/**
 * Retry request without authentication
 */
async function retryRequestWithoutAuth(requestBody) {
    try {
        // Remove user info from request
        delete requestBody.user_id;
        delete requestBody.user_email;
        
        const response = await fetch("/api/chat", {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify(requestBody),
        });

        if (!response.ok) {
            throw new Error(`Retry failed: ${response.status}`);
        }

        return response;
    } catch (retryError) {
        throw new Error(`Could not complete request: ${retryError.message}`);
    }
}

/**
 * Process streaming response
 */
async function processStreamResponse(response, assistantTextEl) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let responseText = "";
    let buffer = "";
    
    const flushAssistantText = () => {
        assistantTextEl.textContent = responseText;
        chatMessages.scrollTop = chatMessages.scrollHeight;
    };

    try {
        while (true) {
            const { done, value } = await reader.read();

            if (done) {
                // Process any remaining data
                const events = parseSSEEvents(buffer + "\n\n");
                for (const data of events.events) {
                    if (data === "[DONE]") break;
                    processResponseData(data, responseText, flushAssistantText);
                }
                break;
            }

            // Decode chunk
            buffer += decoder.decode(value, { stream: true });
            const events = parseSSEEvents(buffer);
            buffer = events.buffer;
            
            for (const data of events.events) {
                if (data === "[DONE]") {
                    buffer = "";
                    break;
                }
                processResponseData(data, responseText, flushAssistantText);
            }
        }
    } finally {
        reader.releaseLock();
    }

    // Add completed response to chat history
    if (responseText.length > 0) {
        chatHistory.push({ role: "assistant", content: responseText });
    }
}

/**
 * Process response data from SSE
 */
function processResponseData(data, responseText, flushCallback) {
    try {
        const jsonData = JSON.parse(data);
        let content = "";
        
        // Handle different response formats
        if (typeof jsonData.response === "string" && jsonData.response.length > 0) {
            content = jsonData.response;
        } else if (jsonData.choices?.[0]?.delta?.content) {
            content = jsonData.choices[0].delta.content;
        } else if (jsonData.content) {
            content = jsonData.content;
        }
        
        if (content) {
            responseText += content;
            flushCallback();
        }
    } catch (e) {
        console.warn("Could not parse SSE data:", e, data);
    }
}

/**
 * Parse Server-Sent Events
 */
function parseSSEEvents(buffer) {
    let normalized = buffer.replace(/\r/g, "");
    const events = [];
    let eventEndIndex;
    
    while ((eventEndIndex = normalized.indexOf("\n\n")) !== -1) {
        const rawEvent = normalized.slice(0, eventEndIndex);
        normalized = normalized.slice(eventEndIndex + 2);

        const lines = rawEvent.split("\n");
        const dataLines = [];
        
        for (const line of lines) {
            if (line.startsWith("data:")) {
                dataLines.push(line.slice("data:".length).trimStart());
            }
        }
        
        if (dataLines.length === 0) continue;
        events.push(dataLines.join("\n"));
    }
    
    return { events, buffer: normalized };
}

/**
 * Handle chat errors
 */
function handleChatError(error) {
    let errorMessage = "Sorry, there was an error processing your request. Please try again.";
    
    if (error.message.includes("Failed to fetch")) {
        errorMessage = "🌐 Connection error. Please check your internet connection.";
    } else if (error.message.includes("401")) {
        errorMessage = "⚠️ Session expired. You can continue chatting without login.";
    } else if (error.message.includes("429")) {
        errorMessage = "⏳ Too many requests. Please wait a moment before trying again.";
    }
    
    addMessageToChat("assistant", errorMessage);
}

/**
 * Add message to chat UI
 */
function addMessageToChat(role, content) {
    const messageEl = document.createElement("div");
    messageEl.className = `message ${role}-message`;
    
    // Format content with line breaks and basic sanitization
    const formattedContent = content
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/\n/g, '<br>')
        .replace(/(https?:\/\/[^\s]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer" style="color: var(--secondary-color); text-decoration: underline;">$1</a>');
    
    messageEl.innerHTML = `<p>${formattedContent}</p>`;
    chatMessages.appendChild(messageEl);

    // Scroll to bottom with smooth animation
    setTimeout(() => {
        chatMessages.scrollTo({
            top: chatMessages.scrollHeight,
            behavior: 'smooth'
        });
    }, 100);
}

/**
 * Clear chat history
 */
function clearChat() {
    if (!confirm("Are you sure you want to clear the chat history?")) return;
    
    chatHistory = [
        {
            role: "assistant",
            content: "Welcome back! How can I assist you today?"
        },
    ];
    
    chatMessages.innerHTML = '';
    addMessageToChat("assistant", chatHistory[0].content);
    
    // Show notification
    if (window.showNotification) {
        window.showNotification("Chat cleared");
    }
}

/**
 * Export functions for debugging
 */
window.chatFunctions = {
    sendMessage,
    clearChat,
    getAuthToken,
    getUserInfo,
    chatHistory: () => chatHistory
};

// Global error handler for chat
window.addEventListener('error', function(e) {
    console.error('Chat error:', e.error);
});

console.log('EleenAI Chat initialized successfully');
