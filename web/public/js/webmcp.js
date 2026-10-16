/**
 * Item 11 — WebMCP.
 *
 * Exposes the running page's actions to an agent operating the browser, via
 * navigator.modelContext. The API is not yet in any stable browser, so this
 * hard feature-detects and is a silent no-op everywhere it is absent.
 *
 * https://webmachinelearning.github.io/webmcp/
 * https://developer.chrome.com/blog/webmcp-epp
 */
(function () {
	'use strict';

	var ctx = navigator.modelContext;
	if (!ctx || typeof ctx.provideContext !== 'function') return;

	/** How long to wait for a streamed reply before giving up. */
	var REPLY_TIMEOUT_MS = 120000;

	function api() {
		return window.chat || null;
	}

	function text(value) {
		return { content: [{ type: 'text', text: String(value) }] };
	}

	function failure(message) {
		return { content: [{ type: 'text', text: message }], isError: true };
	}

	/**
	 * Resolve once the current turn has finished rendering.
	 *
	 * sendMessage resolves before the SSE stream is drained, so the reply is
	 * not in history yet at that point. chat.js dispatches eleen:turn-complete
	 * when it genuinely is.
	 */
	function awaitTurn() {
		return new Promise(function (resolve, reject) {
			var settled = false;

			function done() {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				document.removeEventListener('eleen:turn-complete', done);
				resolve();
			}

			var timer = setTimeout(function () {
				if (settled) return;
				settled = true;
				document.removeEventListener('eleen:turn-complete', done);
				reject(new Error('Timed out waiting for a reply.'));
			}, REPLY_TIMEOUT_MS);

			document.addEventListener('eleen:turn-complete', done);
		});
	}

	function lastAssistantMessage() {
		var chat = api();
		if (!chat) return '';
		var history = chat.history() || [];
		for (var i = history.length - 1; i >= 0; i--) {
			if (history[i].role === 'assistant') return history[i].content || '';
		}
		return '';
	}

	function toMarkdown(history) {
		return history
			.map(function (m) {
				return (m.role === 'user' ? '## User\n\n' : '## EleenAI\n\n') + (m.content || '');
			})
			.join('\n\n');
	}

	var tools = [
		{
			name: 'new_chat',
			description:
				'Clear the current conversation and start a fresh one. Discards all ' +
				'messages in the transcript.',
			inputSchema: { type: 'object', properties: {}, additionalProperties: false },
			execute: function () {
				var chat = api();
				if (!chat) return failure('Chat is not ready yet.');
				// No confirm dialog: nothing would be there to dismiss it.
				chat.clearChat({ confirm: false });
				return text('Started a new chat.');
			}
		},
		{
			name: 'send_message',
			description:
				"Send a message to EleenAI and return its reply. Waits for the full " +
				'streamed response before returning.',
			inputSchema: {
				type: 'object',
				properties: {
					message: { type: 'string', description: 'The message to send.' }
				},
				required: ['message'],
				additionalProperties: false
			},
			execute: function (args) {
				var chat = api();
				if (!chat) return Promise.resolve(failure('Chat is not ready yet.'));

				var message = args && typeof args.message === 'string' ? args.message.trim() : '';
				if (!message) return Promise.resolve(failure('message is required.'));

				if (chat.isProcessing && chat.isProcessing()) {
					return Promise.resolve(failure('A reply is still being generated.'));
				}

				var input = document.getElementById('user-input');
				if (!input) return Promise.resolve(failure('Composer is not available.'));

				input.value = message;
				input.dispatchEvent(new Event('input', { bubbles: true }));

				// Start listening before sending, so a fast reply is not missed.
				var settled = awaitTurn();
				chat.sendMessage();

				return settled.then(
					function () {
						return text(lastAssistantMessage() || '(empty response)');
					},
					function (error) {
						return failure(error.message);
					}
				);
			}
		},
		{
			name: 'set_model',
			description:
				'Set the response mode: balanced for general use, creative for ' +
				'open-ended generation, logical for step-by-step reasoning.',
			inputSchema: {
				type: 'object',
				properties: {
					mode: { type: 'string', enum: ['balanced', 'creative', 'logical'] }
				},
				required: ['mode'],
				additionalProperties: false
			},
			execute: function (args) {
				var mode = args && args.mode;
				// Click the control rather than assign the variable: the mode
				// lives in a module-scoped binding this script cannot reach, and
				// the click handler is what keeps the UI in step with it.
				var button = document.querySelector('.mode-btn[data-mode="' + mode + '"]');
				if (!button) return failure('Unknown mode: ' + mode);
				button.click();
				return text('Response mode set to ' + mode + '.');
			}
		},
		{
			name: 'export_conversation',
			description: 'Return the current conversation as JSON or markdown.',
			inputSchema: {
				type: 'object',
				properties: {
					format: { type: 'string', enum: ['json', 'markdown'], default: 'markdown' }
				},
				additionalProperties: false
			},
			execute: function (args) {
				var chat = api();
				if (!chat) return failure('Chat is not ready yet.');

				var history = chat.history() || [];
				if (!history.length) return text('The conversation is empty.');

				var format = (args && args.format) || 'markdown';
				return text(
					format === 'json' ? JSON.stringify(history, null, 2) : toMarkdown(history)
				);
			}
		}
	];

	try {
		ctx.provideContext({ tools: tools });
	} catch (error) {
		console.warn('WebMCP registration failed:', error);
	}
})();
