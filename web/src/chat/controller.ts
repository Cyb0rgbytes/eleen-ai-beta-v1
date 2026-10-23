/**
 * The conversation: history, sending, stopping, images, feedback.
 *
 * Behaviour carried over from the classic chat.js, deliberately:
 * - History opens with the same assistant greeting and is bounded to 20
 *   turns, keeping the first.
 * - `/imagine <prompt>` goes straight to the image endpoint; an [IMG_GEN]
 *   marker in a reply does the same after the reply finishes.
 * - Feedback is folded into the rated reply's history text.
 * - `eleen:turn-complete` fires when a turn is fully rendered; WebMCP
 *   waits on it. `window.chat` keeps its shape for the same reason.
 *
 * New: the reply streams over protocol 2, Send becomes Stop, usage is
 * shown, errors get a designed state, and the selected mode is sent (the
 * classic page never sent it, so the mode pills did nothing).
 *
 * Saved chats (M4.3): when a chat starts while isSavedMode() (signed in,
 * history on), it is a saved chat for its whole life. Each turn sends only
 * the new user message and the ids (conversationId, parentId or replyTo);
 * the server rebuilds the context from the tree and its meta event returns
 * the new ids. The tree lives in history/state.ts; the page shows the path
 * from the root to activeLeafId. Regenerate adds an assistant sibling, Edit
 * adds a user sibling, and the ‹ n/m › navigator switches between them.
 * A chat started in guest or history-off mode stays a client-history chat
 * exactly as before; it is never migrated.
 */
import type { ChatMessage, ChatRequestBody, ResponseMode } from "../../../src/shared/chat";
import type { ConversationSummary, MessageStatus, StoredMessage } from "../../../src/shared/history";
import { ApiError, request, streamChat } from "../api/client";
import { isSignedIn, openSignIn } from "../auth/clerk";
import { t } from "../i18n";
import { setIcon } from "../ui/icons";
import { showToast } from "../ui/toast";
import { announceConversation, getHistoryState, isSavedMode, setHistoryState, subscribeHistory } from "../history/state";
import { getConversation, patchConversation } from "../history/api";
import { buildTree, deepestLeaf, defaultLeaf, pathTo, siblingInfo } from "../history/tree";
import {
	createAssistantMessage,
	createConversationLoading,
	createImageMessage,
	createImageSkeleton,
	createNotice,
	createThinking,
	createUserMessage,
	createUserTurn,
	replyText,
	setBranchNav,
	setTurnId,
} from "./render";
import { openEditor } from "./edit";
import { follow } from "./scroll";
import { createSpeaker, shouldAutoSpeak, type Speaker } from "./speak";
import { codeText } from "./code";

const MAX_HISTORY = 20;
/** A branch switch is saved once the clicking stops. */
const SWITCH_SAVE_MS = 400;
/** The fallback title the sidebar shows until the server's auto-title lands. */
const TITLE_CHARS = 60;

/** A turn in a saved chat: what to send besides the mode and model. */
interface SavedTurn {
	/** The new user message; absent on a regenerate. */
	text?: string;
	/** The user turn already on the page, to receive its id. */
	userNode?: HTMLElement;
	/** The message the new user turn follows (null for a first turn). */
	parentId: string | null;
	/** Regenerate: the user message to answer again. */
	replyTo?: string;
}

export interface ChatControllerOptions {
	messages: HTMLElement;
	onBusyChange(busy: boolean): void;
	/** Builds the empty state shown before the first message and on a new chat. */
	emptyState(): HTMLElement;
}

export interface SendOptions {
	/** Asked by voice: the reply is kept speakable and, by default, read aloud. */
	voice?: boolean;
}

export interface ChatApi {
	sendMessage(text?: string, options?: SendOptions): Promise<void>;
	stop(): void;
	clearChat(options?: { confirm?: boolean }): boolean;
	/** Start a fresh, unsaved chat without asking. The sidebar's New chat. */
	newChat(): void;
	/**
	 * Show a saved conversation, on the branch ending at leafId (or the one
	 * it was last left on). Rejects if it cannot be loaded.
	 */
	openConversation(conversationId: string, leafId?: string): Promise<void>;
	/** The open saved conversation, or null for a new or unsaved chat. */
	currentConversationId(): string | null;
	regenerate(): Promise<void>;
	history(): ChatMessage[];
	isProcessing(): boolean;
	setMode(mode: ResponseMode): void;
	/** A tier name or model id from the picker, and its display label. */
	setModel(model: string, label: string): void;
	/** Reads replies aloud; shared with the composer's voice-out toggle. */
	readonly speaker: Speaker;
}

function greeting(): ChatMessage[] {
	return [{ role: "assistant", content: t("historyGreeting") }];
}

export function createChat(options: ChatControllerOptions): ChatApi {
	const { messages } = options;
	let history: ChatMessage[] = greeting();
	let busy = false;
	let mode: ResponseMode = "balanced";
	let model = "fast";
	let modelLabel = "";
	let controller: AbortController | null = null;
	const speaker = createSpeaker();
	/** This chat saves to the account (decided when its first message is sent, or by opening one). */
	let saved = false;
	/** The open saved conversation's summary, for the sidebar's updates. */
	let summary: ConversationSummary | null = null;
	/**
	 * Bumped whenever the page switches chats, so a turn still winding down
	 * from the old one cannot write into the new one's tree.
	 */
	let epoch = 0;
	let pendingSwitch: { conversationId: string; leafId: string } | null = null;
	let switchTimer: ReturnType<typeof setTimeout> | undefined;

	/** Read one finished reply aloud, showing it on its Speak button. */
	function speakReply(reply: Element) {
		const text = replyText.get(reply);
		const button = reply.querySelector<HTMLButtonElement>(".speak-button");
		if (!text) return;
		const show = (speaking: boolean) => {
			reply.classList.toggle("is-speaking", speaking);
			if (!button) return;
			button.setAttribute("aria-pressed", String(speaking));
			setIcon(button, speaking ? "stop" : "speaker-high");
			const label = button.querySelector(".sr-only");
			if (label) label.textContent = t(speaking ? "stopSpeaking" : "speak");
			button.title = t(speaking ? "stopSpeaking" : "speak");
		};
		void speaker.speak(text, { onStart: () => show(true), onEnd: () => show(false) });
	}

	document.addEventListener("keydown", (event) => {
		if (event.key === "Escape") speaker.stop();
	});

	function setBusy(next: boolean) {
		busy = next;
		options.onBusyChange(next);
		syncDisabled();
	}

	/** Branch and edit controls wait while a reply streams. */
	function syncDisabled() {
		messages.querySelectorAll<HTMLButtonElement>(".branch-button").forEach((b) => {
			b.disabled = busy || !b.dataset.branch;
		});
		messages.querySelectorAll<HTMLButtonElement>(".edit-button, .edit-save").forEach((b) => {
			b.disabled = busy;
		});
	}

	// ─── Saved-chat tree ────────────────────────────────────────────────────

	const tree = () => buildTree(getHistoryState().messages);

	/** The visible thread of a saved chat, root to active leaf. */
	const thread = () => pathTo(tree(), getHistoryState().activeLeafId);

	const turnNode = (id: string) => messages.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(id)}"]`);

	/** Bring every rendered saved turn's navigator up to date with the tree. */
	function refreshTurns() {
		if (!saved) return;
		const current = tree();
		messages.querySelectorAll<HTMLElement>("[data-message-id]").forEach((node) => {
			setBranchNav(node, siblingInfo(current, node.dataset.messageId ?? ""));
		});
		syncDisabled();
	}

	/** A stored assistant message, replayed through the same renderer as a live one. */
	function replayAssistant(message: StoredMessage): HTMLElement {
		const view = createAssistantMessage();
		view.root.classList.add("is-restored");
		setTurnId(view.root, message.id);
		if (message.status === "error") {
			view.fail(t("errorGeneric"));
			return view.root;
		}
		if (message.reasoning) view.restoreReasoning(message.reasoning);
		view.finish(message.content, {
			...(message.completionTokens !== null ? { completionTokens: message.completionTokens } : {}),
			// A row still marked streaming was cut off before the server heard how it ended.
			stopped: message.status === "stopped" || message.status === "streaming",
			stoppedNote: t("replyStoppedSaved"),
		});
		return view.root;
	}

	/** Rebuild the page from the tree: the path from the root to the active leaf. */
	function renderThread() {
		const path = thread();
		if (!path.length) {
			messages.replaceChildren(options.emptyState());
			return;
		}
		const nodes = path.map((message) => {
			if (message.role === "assistant") return replayAssistant(message);
			const node = createUserTurn(message.content, message.id);
			node.classList.add("is-restored");
			return node;
		});
		messages.replaceChildren(...nodes);
		// Only the newest reply offers Regenerate.
		const last = nodes.at(-1);
		messages.querySelectorAll(".regenerate-button").forEach((b) => {
			if (!last?.contains(b)) b.remove();
		});
		refreshTurns();
	}

	/** Add a finished saved turn to the tree and make its reply the active leaf. */
	function commitTurn(turn: SavedTurn, ids: { userId?: string; assistantId: string }, reply: Omit<StoredMessage, "id" | "parentId" | "seq" | "role" | "createdAt" | "compareGroup">) {
		const state = getHistoryState();
		let seq = state.messages.reduce((max, m) => Math.max(max, m.seq), 0);
		const now = Date.now();
		const added: StoredMessage[] = [];
		if (ids.userId && turn.text !== undefined) {
			added.push({
				id: ids.userId,
				parentId: turn.parentId,
				seq: ++seq,
				role: "user",
				content: turn.text,
				reasoning: null,
				model: null,
				status: "complete",
				compareGroup: null,
				completionTokens: null,
				createdAt: now,
			});
		}
		const parentId = ids.userId ?? turn.replyTo ?? null;
		added.push({ ...reply, id: ids.assistantId, parentId, seq: ++seq, role: "assistant", compareGroup: null, createdAt: now });
		setHistoryState({ messages: [...state.messages, ...added], activeLeafId: ids.assistantId });
		if (summary) {
			summary = { ...summary, updatedAt: now };
			announceConversation(summary);
		}
	}

	/** The meta event named the conversation: adopt it, announcing a new one to the sidebar. */
	function adoptConversation(conversationId: string, firstText: string | undefined) {
		const state = getHistoryState();
		if (state.conversationId === conversationId) return;
		const now = Date.now();
		summary = {
			id: conversationId,
			title: (firstText ?? "").slice(0, TITLE_CHARS),
			pinned: false,
			folderId: null,
			createdAt: now,
			updatedAt: now,
		};
		setHistoryState({ conversationId });
		announceConversation(summary);
	}

	function flushSwitch() {
		clearTimeout(switchTimer);
		const pending = pendingSwitch;
		pendingSwitch = null;
		if (!pending) return;
		patchConversation(pending.conversationId, { activeLeafId: pending.leafId }).catch(() =>
			showToast(t("branchSwitchFailed"), "error"),
		);
	}

	/** Save the visible branch, once the clicking stops. */
	function saveSwitch(conversationId: string, leafId: string) {
		if (pendingSwitch && pendingSwitch.conversationId !== conversationId) flushSwitch();
		pendingSwitch = { conversationId, leafId };
		clearTimeout(switchTimer);
		switchTimer = setTimeout(flushSwitch, SWITCH_SAVE_MS);
	}

	/** A new turn moves the active leaf on the server itself; a pending switch would undo it. */
	function dropSwitch() {
		clearTimeout(switchTimer);
		pendingSwitch = null;
	}

	/** Show the sibling a navigator button points at, down to its newest leaf. */
	function switchBranch(siblingId: string) {
		const state = getHistoryState();
		if (busy || !saved || !state.conversationId) return;
		const current = tree();
		if (!current.byId.has(siblingId)) return;
		const leafId = deepestLeaf(current, siblingId);
		speaker.stop();
		setHistoryState({ activeLeafId: leafId });
		renderThread();
		// Keep the switched turn where the reader is looking.
		turnNode(siblingId)?.querySelector<HTMLButtonElement>(".branch-nav button:not(:disabled)")?.focus({ preventScroll: true });
		turnNode(siblingId)?.scrollIntoView({ block: "nearest" });
		saveSwitch(state.conversationId, leafId);
	}

	/**
	 * A saved chat whose saving was switched off (history turned off in the
	 * panel) carries on as a client-history chat from what is on screen. It
	 * is not migrated anywhere; it just stops sending ids.
	 */
	function leaveSavedMode() {
		history = [...greeting(), ...thread().map((m): ChatMessage => ({ role: m.role, content: m.content }))];
		bound();
		saved = false;
		summary = null;
		dropSwitch();
		messages.querySelectorAll(".branch-nav, .edit-button").forEach((n) => n.remove());
		setHistoryState({ conversationId: null, messages: [], activeLeafId: null });
	}

	/** Re-read the tree after a turn whose ids never arrived (stopped before meta). */
	async function resync(conversationId: string, at: number) {
		try {
			const detail = await getConversation(conversationId);
			if (at !== epoch || busy || getHistoryState().conversationId !== conversationId) return;
			const current = buildTree(detail.messages);
			setHistoryState({
				messages: detail.messages,
				activeLeafId: detail.conversation.activeLeafId ?? defaultLeaf(current),
			});
			renderThread();
		} catch {
			// The page still shows the turn; the next one follows the last known leaf.
		}
	}

	function append(node: HTMLElement, { force = false } = {}) {
		messages.append(node);
		requestAnimationFrame(() => follow(messages, { force }));
	}

	function bound() {
		if (history.length > MAX_HISTORY) {
			const first = history[0];
			history = first ? [first, ...history.slice(-(MAX_HISTORY - 1))] : history.slice(-MAX_HISTORY);
		}
	}

	/** A designed notice for the failures a person can act on. */
	function failureNotice(error: unknown): HTMLElement | null {
		if (!(error instanceof ApiError)) return null;
		if (error.kind === "rate-limited") {
			const minutes = error.retryAfter ? Math.max(1, Math.ceil(error.retryAfter / 60)) : null;
			const node = createNotice([
				{ text: t("rateLimitTitle") },
				{ text: minutes ? t("errorRateLimit", { minutes }) : t("errorRateLimitSoon"), emphasis: true },
			]);
			node.classList.add("is-limit");
			if (!isSignedIn()) {
				const body = node.querySelector(".message-body");
				const button = document.createElement("button");
				button.type = "button";
				button.className = "auth-button primary-cta";
				const label = document.createElement("span");
				label.textContent = t("signIn");
				button.append(label);
				button.addEventListener("click", () => void openSignIn());
				body?.append(button);
			}
			return node;
		}
		return null;
	}

	function errorText(error: unknown): string {
		if (error instanceof ApiError) {
			if (error.kind === "network") return t("errorNetwork");
			if (error.kind === "timeout") return t("errorTimeout");
			if (error.kind === "forbidden") {
				const name = modelLabel || t("thisModel");
				return error.reason === "key-required"
					? t("errorKeyRequired", { model: name })
					: t("errorSignIn", { model: name });
			}
		}
		return t("errorGeneric");
	}

	async function generateImage(prompt: string): Promise<boolean> {
		// A skeleton where the image will appear, instead of a status line.
		const placeholder = createImageSkeleton(prompt);
		append(placeholder, { force: true });
		try {
			const authenticated = isSignedIn();
			const response = await request(authenticated ? "/api/image/generate" : "/api/image/generate/guest", {
				method: "POST",
				body: { prompt },
				auth: authenticated,
				timeoutMs: 90_000,
			});
			const url = URL.createObjectURL(await response.blob());
			placeholder.replaceWith(createImageMessage(url, prompt));
			return true;
		} catch (error) {
			const notice = failureNotice(error);
			if (notice) placeholder.replaceWith(notice);
			else {
				const view = createAssistantMessage();
				placeholder.replaceWith(view.root);
				view.fail(t("errorImage"));
			}
			return false;
		} finally {
			requestAnimationFrame(() => follow(messages));
		}
	}

	/** Nothing sent yet in this chat. */
	function isFresh(): boolean {
		return saved ? getHistoryState().messages.length === 0 && !getHistoryState().conversationId : history.length <= 1;
	}

	function clearInput(input: HTMLTextAreaElement | null, text: string | undefined) {
		if (input && text === undefined) {
			input.value = "";
			input.dispatchEvent(new Event("input"));
		}
	}

	/** `/imagine` in a saved chat: shown, not saved (the server stores no images). */
	async function imagineTurn(message: string): Promise<void> {
		try {
			await generateImage(message.slice("/imagine ".length).trim());
		} finally {
			setBusy(false);
			document.dispatchEvent(new CustomEvent("eleen:turn-complete"));
		}
	}

	async function sendMessage(text?: string, { voice = false }: SendOptions = {}): Promise<void> {
		const input = document.getElementById("user-input") as HTMLTextAreaElement | null;
		const message = (text ?? input?.value ?? "").trim();
		if (!message || busy) return;

		// A chat's mode is fixed by its first message; a chat already under
		// way never changes into the other kind.
		if (isFresh()) saved = isSavedMode();
		else if (saved && !isSavedMode()) leaveSavedMode();

		speaker.stop();
		setBusy(true);
		messages.querySelector(".empty-state")?.remove();
		const imagine = message.toLowerCase().startsWith("/imagine ");

		if (saved) {
			const userNode = createUserTurn(message);
			append(userNode, { force: true });
			clearInput(input, text);
			if (imagine) {
				// Generated images are not saved: the turn stays on the page only.
				await imagineTurn(message);
				return;
			}
			await runTurn({ voice, save: { text: message, userNode, parentId: getHistoryState().activeLeafId } });
			return;
		}

		append(createUserMessage(message), { force: true });
		clearInput(input, text);
		history.push({ role: "user", content: message });

		if (imagine) {
			try {
				const prompt = message.slice("/imagine ".length).trim();
				if (await generateImage(prompt)) history.push({ role: "assistant", content: `[Generated image: ${prompt}]` });
			} finally {
				bound();
				setBusy(false);
				document.dispatchEvent(new CustomEvent("eleen:turn-complete"));
			}
			return;
		}
		await runTurn({ voice });
	}

	/**
	 * Ask again for the newest reply: drop it from the page and the history,
	 * then stream a fresh one from the same conversation.
	 */
	async function regenerate(): Promise<void> {
		if (busy) return;
		if (saved) {
			await regenerateSaved();
			return;
		}
		const last = history.at(-1);
		if (last?.role !== "assistant" || history.length < 2) return;
		history.pop();
		const replies = messages.querySelectorAll(".assistant-message");
		replies[replies.length - 1]?.remove();
		speaker.stop();
		setBusy(true);
		await runTurn();
	}

	/**
	 * Regenerate in a saved chat: a new assistant sibling answering the same
	 * user turn. The old reply leaves the page but stays in the tree, one
	 * click away on the navigator.
	 */
	async function regenerateSaved(): Promise<void> {
		const leafId = getHistoryState().activeLeafId;
		const leaf = leafId ? tree().byId.get(leafId) : undefined;
		if (!getHistoryState().conversationId || leaf?.role !== "assistant" || !leaf.parentId) return;
		const node = turnNode(leaf.id);
		// The reply and anything shown after it (a generated image).
		while (node?.nextSibling) node.nextSibling.remove();
		node?.remove();
		speaker.stop();
		setBusy(true);
		await runTurn({ save: { parentId: leaf.parentId, replyTo: leaf.parentId } });
	}

	/**
	 * Edit in a saved chat: everything from the edited turn down leaves the
	 * page, and the new text is sent as its sibling (same parent).
	 */
	async function editTurn(turn: HTMLElement, text: string): Promise<void> {
		const id = turn.dataset.messageId;
		const message = id ? tree().byId.get(id) : undefined;
		if (busy || !saved || !message || message.role !== "user") return;
		while (turn.nextSibling) turn.nextSibling.remove();
		speaker.stop();
		setBusy(true);
		setHistoryState({ activeLeafId: message.parentId });
		const userNode = createUserTurn(text);
		turn.replaceWith(userNode);
		requestAnimationFrame(() => follow(messages, { force: true }));
		await runTurn({ save: { text, userNode, parentId: message.parentId } });
	}

	function requestBody(save: SavedTurn | undefined, voice: boolean): ChatRequestBody {
		const shared = { mode, model, ...(voice ? { voice: true } : {}) };
		if (!save) return { messages: history, ...shared };
		const conversationId = getHistoryState().conversationId;
		return {
			messages: save.text !== undefined ? [{ role: "user", content: save.text }] : [],
			...shared,
			...(conversationId ? { conversationId } : {}),
			...(save.replyTo ? { replyTo: save.replyTo } : { parentId: save.parentId }),
		};
	}

	/**
	 * Stream one assistant turn: from the client history, or, in a saved
	 * chat, from the tree on the server. Owns busy and the turn-complete event.
	 */
	async function runTurn({ voice = false, save }: SendOptions & { save?: SavedTurn } = {}): Promise<void> {
		const thinking = createThinking();
		append(thinking, { force: true });
		// Only the newest reply offers Regenerate.
		messages.querySelectorAll(".regenerate-button").forEach((b) => b.remove());

		const at = epoch;
		let ids: { userId?: string; assistantId: string } | null = null;
		let raw = "";
		let reasoningText = "";
		let completionTokens: number | undefined;
		let status: MessageStatus = "complete";
		let replyModel: string | null = null;
		if (save) dropSwitch();

		try {
			controller = new AbortController();
			const view = createAssistantMessage();
			let failed: string | null = null;
			let started = false;

			const begin = () => {
				if (started) return;
				started = true;
				thinking.replaceWith(view.root);
			};

			try {
				for await (const event of streamChat(requestBody(save, voice), {
					authenticated: isSignedIn(),
					signal: controller.signal,
				})) {
					if (event.type === "meta") {
						replyModel = event.data.model ?? null;
						if (save && at === epoch && event.data.conversationId && event.data.assistantMessageId) {
							ids = { assistantId: event.data.assistantMessageId };
							if (event.data.userMessageId) ids.userId = event.data.userMessageId;
							adoptConversation(event.data.conversationId, save.text);
							setTurnId(view.root, ids.assistantId);
							if (ids.userId && save.userNode) setTurnId(save.userNode, ids.userId);
						}
						continue;
					}
					if (event.type === "reasoning") reasoningText += event.data.text;
					if (event.type === "reasoning") {
						begin();
						view.reason(event.data.text);
						requestAnimationFrame(() => follow(messages));
					} else if (event.type === "token") {
						begin();
						raw += event.data.text;
						view.update(raw);
						requestAnimationFrame(() => follow(messages));
					} else if (event.type === "usage") {
						completionTokens = event.data.completionTokens;
					} else if (event.type === "error") {
						failed = event.data.message;
					}
				}
			} catch (error) {
				if (!(error instanceof ApiError && error.kind === "aborted")) throw error;
			}

			const stopped = controller.signal.aborted;
			if (stopped) status = "stopped";
			begin();
			if (failed !== null) {
				status = "error";
				view.fail(failed);
			} else {
				const extracted = view.finish(raw, {
					completionTokens,
					stopped,
					...(save && ids ? { stoppedNote: t("replyStoppedSaved") } : {}),
				});
				if (!save && raw.trim()) history.push({ role: "assistant", content: raw });
				if (!stopped && extracted.text && shouldAutoSpeak(voice)) speakReply(view.root);
				// The tree must hold this turn before an image is shown under it.
				if (save && ids && at === epoch) {
					commitTurn(save, ids, reply());
					ids = null;
				}
				if (extracted.imagePrompt && !stopped) await generateImage(extracted.imagePrompt);
			}
			requestAnimationFrame(() => follow(messages));
		} catch (error) {
			status = "error";
			thinking.remove();
			const notice = failureNotice(error);
			if (notice) {
				append(notice, { force: true });
			} else {
				const view = createAssistantMessage();
				append(view.root);
				view.fail(errorText(error));
			}
		} finally {
			const wasStopped = controller?.signal.aborted ?? false;
			controller = null;
			thinking.remove();
			if (save && at === epoch) {
				if (ids) commitTurn(save, ids, reply());
				else if (wasStopped) {
					// Stopped before the ids arrived: the server may still have
					// saved the turn, so read the tree back rather than guess.
					const conversationId = getHistoryState().conversationId;
					if (conversationId) void resync(conversationId, at);
				}
				refreshTurns();
			}
			bound();
			setBusy(false);
			document.dispatchEvent(new CustomEvent("eleen:turn-complete"));
		}

		function reply() {
			return {
				content: raw,
				reasoning: reasoningText || null,
				model: replyModel,
				status,
				completionTokens: completionTokens ?? null,
			};
		}
	}

	function stop() {
		controller?.abort();
		speaker.stop();
	}

	function newChat() {
		stop();
		epoch++;
		flushSwitch();
		history = greeting();
		saved = false;
		summary = null;
		messages.replaceChildren(options.emptyState());
		setHistoryState({ conversationId: null, messages: [], activeLeafId: null });
	}

	/**
	 * Show a saved conversation on the branch ending at leafId (followed down
	 * to its newest leaf), or the branch it was last left on.
	 */
	async function openConversation(conversationId: string, leafId?: string): Promise<void> {
		stop();
		flushSwitch();
		const at = ++epoch;
		const before = [...messages.childNodes];
		const loading = createConversationLoading();
		messages.replaceChildren(loading);

		let detail: Awaited<ReturnType<typeof getConversation>>;
		try {
			detail = await getConversation(conversationId);
		} catch (error) {
			if (at === epoch) {
				// Back to what was there; nothing about it changed.
				messages.replaceChildren(...before);
				showToast(t("conversationLoadFailed"), "error");
			}
			throw error;
		}
		if (at !== epoch) return;

		const current = buildTree(detail.messages);
		const stored = detail.conversation.activeLeafId;
		const leaf =
			leafId && current.byId.has(leafId)
				? deepestLeaf(current, leafId)
				: stored && current.byId.has(stored)
					? stored
					: defaultLeaf(current);
		const c = detail.conversation;
		summary = { id: c.id, title: c.title, pinned: c.pinned, folderId: c.folderId, createdAt: c.createdAt, updatedAt: c.updatedAt };
		saved = true;
		history = greeting();
		setHistoryState({ conversationId, messages: detail.messages, activeLeafId: leaf });
		renderThread();

		const target = leafId ? turnNode(leafId) : null;
		if (target) {
			requestAnimationFrame(() => target.scrollIntoView({ block: "center" }));
		} else {
			requestAnimationFrame(() => follow(messages, { force: true }));
		}
		if (leafId && leaf && leaf !== stored) saveSwitch(conversationId, leaf);
	}

	function clearChat({ confirm: ask = true } = {}): boolean {
		if (ask && !window.confirm(t("clearConfirm"))) return false;
		newChat();
		return true;
	}

	/** Fold a rating into the newest assistant turn, as the classic page did. */
	function rate(kind: "up" | "down") {
		for (let i = history.length - 1; i >= 0; i--) {
			const turn = history[i];
			if (turn?.role !== "assistant") continue;
			const base = turn.content.replace(/\n\n\[User rated this response as: (Good|Bad)\]$/, "");
			turn.content = `${base}\n\n[User rated this response as: ${kind === "up" ? "Good" : "Bad"}]`;
			break;
		}
	}

	// One delegated listener for everything rendered inside messages.
	messages.addEventListener("click", (event) => {
		if (!(event.target instanceof Element)) return;

		const chip = event.target.closest<HTMLElement>(".suggestion-chip, .prompt-card");
		if (chip) {
			void sendMessage(chip.dataset.suggestion ?? chip.dataset.prompt ?? "");
			return;
		}

		const feedback = event.target.closest<HTMLButtonElement>("[data-feedback]");
		if (feedback) {
			const group = feedback.parentElement;
			group?.querySelectorAll("button").forEach((b) => {
				b.classList.remove("active");
				b.setAttribute("aria-pressed", "false");
			});
			feedback.classList.add("active");
			feedback.setAttribute("aria-pressed", "true");
			rate(feedback.dataset.feedback === "up" ? "up" : "down");
			showToast(t("feedbackThanks"), "success", 2000);
			return;
		}

		const branch = event.target.closest<HTMLButtonElement>(".branch-button");
		if (branch) {
			if (!branch.disabled && branch.dataset.branch) switchBranch(branch.dataset.branch);
			return;
		}

		const action = event.target.closest<HTMLButtonElement>("[data-action]");
		if (action) {
			const reply = action.closest(".assistant-message");
			if (action.dataset.action === "edit") {
				const turn = action.closest<HTMLElement>(".user-turn");
				const id = turn?.dataset.messageId;
				const message = id ? tree().byId.get(id) : undefined;
				if (turn && message && !busy) {
					openEditor(turn, message.content, { onSave: (text) => void editTurn(turn, text) });
					syncDisabled();
				}
			} else if (action.dataset.action === "regenerate") {
				void regenerate();
			} else if (action.dataset.action === "copy" && reply) {
				void copyReply(action, replyText.get(reply) ?? "");
			} else if (action.dataset.action === "copy-code") {
				void copyReply(action, codeText(action), "copyCode");
			} else if (action.dataset.action === "speak" && reply) {
				if (reply.classList.contains("is-speaking")) speaker.stop();
				else speakReply(reply);
			}
			return;
		}

		const image = event.target.closest<HTMLImageElement>(".chat-image");
		if (image) window.open(image.src, "_blank", "noopener");
	});

	// Deleting all history (privacy/panel.ts, HISTORY_DELETED_EVENT; that
	// module loads on demand, so its constant is not imported here) leaves
	// nothing to show for an open saved chat.
	window.addEventListener("eleen:history-deleted", () => {
		if (saved) newChat();
	});

	// Signing out forgets the tree (history/state.ts); the page follows.
	subscribeHistory((state) => {
		if (!state.signedIn && saved) newChat();
	});

	/** Copy a reply's (or a code block's) text; the icon morphs to a check and back (DESIGN.md 7). */
	async function copyReply(button: HTMLButtonElement, text: string, labelKey: "copy" | "copyCode" = "copy"): Promise<void> {
		try {
			await navigator.clipboard.writeText(text);
		} catch {
			showToast(t("copyFailed"), "error");
			return;
		}
		const label = button.querySelector(".sr-only");
		button.classList.add("is-done");
		setIcon(button, "check");
		if (label) label.textContent = t("copied");
		setTimeout(() => {
			button.classList.remove("is-done");
			setIcon(button, "copy");
			if (label) label.textContent = t(labelKey);
		}, 1500);
	}

	return {
		sendMessage,
		stop,
		clearChat,
		newChat,
		openConversation,
		currentConversationId: () => getHistoryState().conversationId,
		regenerate,
		// A saved chat's history is the visible thread, read from the tree.
		history: () =>
			saved ? [...greeting(), ...thread().map((m): ChatMessage => ({ role: m.role, content: m.content }))] : history,
		isProcessing: () => busy,
		setMode: (next) => {
			mode = next;
		},
		setModel: (next, label) => {
			model = next;
			modelLabel = label;
		},
		speaker,
	};
}
