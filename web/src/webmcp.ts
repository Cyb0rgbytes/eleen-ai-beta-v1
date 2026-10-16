/**
 * WebMCP: the page's actions for an agent driving the browser, through
 * navigator.modelContext. Not yet in any stable browser, so this is a
 * silent no-op wherever the API is absent.
 *
 * Ported from the classic js/webmcp.js with the same four tools and the
 * same contract: tools act through window.chat, and send_message waits for
 * eleen:turn-complete rather than polling.
 *
 * https://webmachinelearning.github.io/webmcp/
 */
import type { ChatMessage } from "../../src/shared/chat";
import type { ChatApi } from "./chat/controller";

interface ToolResult {
	content: { type: "text"; text: string }[];
	isError?: boolean;
}

interface ModelContext {
	provideContext(context: { tools: unknown[] }): void;
}

const REPLY_TIMEOUT_MS = 120_000;

const text = (value: string): ToolResult => ({ content: [{ type: "text", text: value }] });
const failure = (message: string): ToolResult => ({ content: [{ type: "text", text: message }], isError: true });

function awaitTurn(): Promise<void> {
	return new Promise((resolve, reject) => {
		const done = () => {
			clearTimeout(timer);
			resolve();
		};
		const timer = setTimeout(() => {
			document.removeEventListener("eleen:turn-complete", done);
			reject(new Error("Timed out waiting for a reply."));
		}, REPLY_TIMEOUT_MS);
		document.addEventListener("eleen:turn-complete", done, { once: true });
	});
}

function lastAssistant(history: ChatMessage[]): string {
	for (let i = history.length - 1; i >= 0; i--) {
		const turn = history[i];
		if (turn?.role === "assistant") return turn.content;
	}
	return "";
}

function toMarkdown(history: ChatMessage[]): string {
	return history.map((m) => `${m.role === "user" ? "## User" : "## EleenAI"}\n\n${m.content}`).join("\n\n");
}

export function registerWebMcp(chat: ChatApi): void {
	const ctx = (navigator as Navigator & { modelContext?: ModelContext }).modelContext;
	if (!ctx || typeof ctx.provideContext !== "function") return;

	const tools = [
		{
			name: "new_chat",
			description: "Clear the current conversation and start a fresh one. Discards all messages in the transcript.",
			inputSchema: { type: "object", properties: {}, additionalProperties: false },
			execute: () => {
				// No confirm dialog: nothing would be there to dismiss it.
				chat.clearChat({ confirm: false });
				return text("Started a new chat.");
			},
		},
		{
			name: "send_message",
			description: "Send a message to EleenAI and return its reply. Waits for the full streamed response before returning.",
			inputSchema: {
				type: "object",
				properties: { message: { type: "string", description: "The message to send." } },
				required: ["message"],
				additionalProperties: false,
			},
			execute: async (args: { message?: unknown }) => {
				const message = typeof args?.message === "string" ? args.message.trim() : "";
				if (!message) return failure("message is required.");
				if (chat.isProcessing()) return failure("A reply is still being generated.");
				// Listen before sending, so a fast reply is not missed.
				const settled = awaitTurn();
				void chat.sendMessage(message);
				try {
					await settled;
					return text(lastAssistant(chat.history()) || "(empty response)");
				} catch (error) {
					return failure(error instanceof Error ? error.message : "Failed.");
				}
			},
		},
		{
			name: "set_model",
			description:
				"Set the response mode: balanced for general use, creative for open-ended generation, logical for step-by-step reasoning.",
			inputSchema: {
				type: "object",
				properties: { mode: { type: "string", enum: ["balanced", "creative", "logical"] } },
				required: ["mode"],
				additionalProperties: false,
			},
			execute: (args: { mode?: unknown }) => {
				const mode = typeof args?.mode === "string" ? args.mode : "";
				// Click the control so the UI stays in step with the state.
				const button = [...document.querySelectorAll<HTMLButtonElement>(".mode-btn")].find((b) => b.dataset.mode === mode);
				if (!button) return failure(`Unknown mode: ${mode}`);
				button.click();
				return text(`Response mode set to ${mode}.`);
			},
		},
		{
			name: "export_conversation",
			description: "Return the current conversation as JSON or markdown.",
			inputSchema: {
				type: "object",
				properties: { format: { type: "string", enum: ["json", "markdown"], default: "markdown" } },
				additionalProperties: false,
			},
			execute: (args: { format?: unknown }) => {
				const history = chat.history();
				if (!history.length) return text("The conversation is empty.");
				return text(args?.format === "json" ? JSON.stringify(history, null, 2) : toMarkdown(history));
			},
		},
	];

	try {
		ctx.provideContext({ tools });
	} catch (error) {
		console.warn("WebMCP registration failed:", error);
	}
}
