/**
 * LLM Chat App Frontend
 *
 * Handles the chat UI interactions and communication with the backend API.
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
        content:
            "Welcome to the ELEENAI Gateway. I'm your conduit to the realm of artificial intelligence. How may I assist you on this journey?",
    },
];
let isProcessing = false;
let auth0Client = null;

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

/**
 * Initialize chat with Auth0
 */
async function initializeChat() {
    try {
        // Try to get Auth0 client from parent window or create a new one
        if (window.auth0Client) {
            auth0Client = window.auth0Client;
        } else {
            // Fallback: Check if user is authenticated via token
            const token = localStorage.getItem('auth_token');
            if (!token) {
                console.log('User not authenticated');
                return;
            }
        }
        
        // Enable chat interface
        userInput.disabled = false;
        userInput.placeholder = "Enter your query to open the gateway...";
        sendButton.disabled = false;
        userInput.focus();
        
    } catch (error) {
        console.error('Failed to initialize chat:', error);
        userInput.disabled = true;
        userInput.placeholder = "Authentication error. Please refresh the page.";
        sendButton.disabled = true;
    }
}

/**
 * Get authentication token
 */
async function getAuthToken() {
    try {
        if (auth0Client) {
            // Get token silently from Auth0
            return await auth0Client.getTokenSilently();
        } else {
            // Fallback to localStorage token
            const token = localStorage.getItem('auth_token');
            if (token) {
                // Verify token is not expired (simple check)
                const payload = JSON.parse(atob(token.split('.')[1]));
                const now = Math.floor(Date.now() / 1000);
                if (payload.exp && payload.exp > now) {
                    return token;
                } else {
                    // Token expired
                    localStorage.removeItem('auth_token');
                    throw new Error('Token expired');
                }
            }
            throw new Error('No token found');
        }
    } catch (error) {
        console.error('Failed to get auth token:', error);
        // Trigger re-authentication
        if (window.login) {
            window.login();
        } else {
            alert('Please login to continue.');
        }
        throw error;
    }
}

/**
 * Sends a message to the chat API and processes the response
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
        // Get authentication token
        const token = await getAuthToken();
        
        // Create new assistant response element
        const assistantMessageEl = document.createElement("div");
        assistantMessageEl.className = "message assistant-message";
        assistantMessageEl.innerHTML = "<p></p>";
        chatMessages.appendChild(assistantMessageEl);
        const assistantTextEl = assistantMessageEl.querySelector("p");

        // Scroll to bottom
        chatMessages.scrollTop = chatMessages.scrollHeight;

        // Send request to API with authentication
        const response = await fetch("/api/chat", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${token}`
            },
            body: JSON.stringify({
                messages: chatHistory,
                user_id: await getUserId() // Optional: Send user ID for personalization
            }),
        });

        // Handle authentication errors
        if (response.status === 401) {
            // Token expired or invalid
            localStorage.removeItem('auth_token');
            if (window.login) {
                window.login();
            }
            throw new Error("Authentication required. Please login again.");
        }

        // Handle other errors
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`API Error: ${response.status} - ${errorText}`);
        }
        
        if (!response.body) {
            throw new Error("Response body is null");
        }

        // Process streaming response
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let responseText = "";
        let buffer = "";
        const flushAssistantText = () => {
            assistantTextEl.textContent = responseText;
            chatMessages.scrollTop = chatMessages.scrollHeight;
        };

        let sawDone = false;
        while (true) {
            const { done, value } = await reader.read();

            if (done) {
                // Process any remaining complete events in buffer
                const parsed = consumeSseEvents(buffer + "\n\n");
                for (const data of parsed.events) {
                    if (data === "[DONE]") {
                        break;
                    }
                    try {
                        const jsonData = JSON.parse(data);
                        // Handle both Workers AI format (response) and OpenAI format (choices[0].delta.content)
                        let content = "";
                        if (
                            typeof jsonData.response === "string" &&
                            jsonData.response.length > 0
                        ) {
                            content = jsonData.response;
                        } else if (jsonData.choices?.[0]?.delta?.content) {
                            content = jsonData.choices[0].delta.content;
                        }
                        if (content) {
                            responseText += content;
                            flushAssistantText();
                        }
                    } catch (e) {
                        console.error("Error parsing SSE data as JSON:", e, data);
                    }
                }
                break;
            }

            // Decode chunk
            buffer += decoder.decode(value, { stream: true });
            const parsed = consumeSseEvents(buffer);
            buffer = parsed.buffer;
            for (const data of parsed.events) {
                if (data === "[DONE]") {
                    sawDone = true;
                    buffer = "";
                    break;
                }
                try {
                    const jsonData = JSON.parse(data);
                    // Handle both Workers AI format (response) and OpenAI format (choices[0].delta.content)
                    let content = "";
                    if (
                        typeof jsonData.response === "string" &&
                        jsonData.response.length > 0
                    ) {
                        content = jsonData.response;
                    } else if (jsonData.choices?.[0]?.delta?.content) {
                        content = jsonData.choices[0].delta.content;
                    }
                    if (content) {
                        responseText += content;
                        flushAssistantText();
                    }
                } catch (e) {
                    console.error("Error parsing SSE data as JSON:", e, data);
                }
            }
            if (sawDone) {
                break;
            }
        }

        // Add completed response to chat history
        if (responseText.length > 0) {
            chatHistory.push({ role: "assistant", content: responseText });
        }
        
        // Limit chat history to prevent token overflow (optional)
        if (chatHistory.length > 20) {
            chatHistory = [
                chatHistory[0], // Keep initial greeting
                ...chatHistory.slice(-19) // Keep last 19 messages
            ];
        }
        
    } catch (error) {
        console.error("Error:", error);
        
        // Handle different types of errors
        if (error.message.includes("Authentication") || error.message.includes("401")) {
            addMessageToChat(
                "assistant",
                "⚠️ Authentication required. Please login to continue the conversation."
            );
            // Show login button
            userInput.placeholder = "Click the Login button above to continue...";
        } else if (error.message.includes("Failed to fetch")) {
            addMessageToChat(
                "assistant",
                "🌐 Connection error. Please check your internet connection and try again."
            );
        } else {
            addMessageToChat(
                "assistant",
                "Sorry, there was an error processing your request. Please try again."
            );
        }
    } finally {
        // Hide typing indicator
        typingIndicator.classList.remove("visible");

        // Re-enable input (if user is still authenticated)
        isProcessing = false;
        const token = localStorage.getItem('auth_token');
        if (token) {
            userInput.disabled = false;
            sendButton.disabled = false;
            userInput.focus();
        } else {
            // Keep disabled if not authenticated
            userInput.placeholder = "Please login to access the gateway...";
        }
    }
}

/**
 * Helper function to add message to chat
 */
function addMessageToChat(role, content) {
    const messageEl = document.createElement("div");
    messageEl.className = `message ${role}-message`;
    
    // Sanitize content to prevent XSS
    const sanitizedContent = content
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;')
        .replace(/\n/g, '<br>');
    
    messageEl.innerHTML = `<p>${sanitizedContent}</p>`;
    chatMessages.appendChild(messageEl);

    // Scroll to bottom
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

/**
 * Get user ID from Auth0 token
 */
async function getUserId() {
    try {
        const token = await getAuthToken();
        if (token) {
            // Decode JWT payload to get user info
            const payload = JSON.parse(atob(token.split('.')[1]));
            return payload.sub || payload.email || 'anonymous';
        }
    } catch (error) {
        console.error('Failed to get user ID:', error);
    }
    return 'anonymous';
}

/**
 * SSE event parser
 */
function consumeSseEvents(buffer) {
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
 * Clear chat history (can be called from console or UI)
 */
function clearChat() {
    chatHistory = [
        {
            role: "assistant",
            content: "Welcome back! How can I assist you today?",
        },
    ];
    chatMessages.innerHTML = '';
    addMessageToChat("assistant", chatHistory[0].content);
}

/**
 * Export functions for global access
 */
window.chatFunctions = {
    initializeChat,
    clearChat,
    sendMessage
};

// Initialize chat when page loads
document.addEventListener('DOMContentLoaded', function() {
    // Check if we're authenticated
    const token = localStorage.getItem('auth_token');
    if (token) {
        initializeChat();
    } else {
        userInput.disabled = true;
        userInput.placeholder = "Please login to access the gateway...";
        sendButton.disabled = true;
    }
    
    // Listen for authentication changes
    window.addEventListener('storage', function(e) {
        if (e.key === 'auth_token') {
            if (e.newValue) {
                initializeChat();
            } else {
                userInput.disabled = true;
                userInput.placeholder = "Please login to access the gateway...";
                sendButton.disabled = true;
                chatMessages.innerHTML = '';
                chatHistory = [
                    {
                        role: "assistant",
                        content: "Welcome to the ELEENAI Gateway. Please login to continue.",
                    },
                ];
                addMessageToChat("assistant", chatHistory[0].content);
            }
        }
    });
});
