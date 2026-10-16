/**
 * The empty state (DESIGN.md section 7): a greeting with the brand
 * gradient on its first line, one subtitle, and exactly as many prompt
 * cards as there are prompts. It replaces the welcome bubble until the
 * first message is sent, and comes back on a new chat.
 *
 * A card sends its prompt straight away, as a suggestion chip does.
 */
import { t, type MessageKey } from "../i18n";
import { icon, type IconName } from "../ui/icons";

interface PromptCard {
	icon: IconName;
	title: MessageKey;
	prompt: MessageKey;
}

const CARDS: readonly PromptCard[] = [
	{ icon: "lightbulb", title: "cardExplainTitle", prompt: "cardExplainPrompt" },
	{ icon: "shield-check", title: "cardSecureTitle", prompt: "cardSecurePrompt" },
	{ icon: "image", title: "cardImageTitle", prompt: "cardImagePrompt" },
	{ icon: "code", title: "cardCodeTitle", prompt: "cardCodePrompt" },
];

export function createEmptyState(name: string | null): HTMLElement {
	const root = document.createElement("section");
	root.className = "empty-state";
	root.setAttribute("aria-labelledby", "empty-greeting");

	const heading = document.createElement("h1");
	heading.id = "empty-greeting";
	heading.className = "empty-greeting";
	// Each line is its own paragraph with its own direction: a name typed in
	// another script must not flip the question below it.
	const hello = document.createElement("span");
	hello.className = "empty-hello";
	hello.dir = "auto";
	hello.textContent = name ? t("helloName", { name }) : t("hello");
	const ask = document.createElement("span");
	ask.className = "empty-ask";
	ask.dir = "auto";
	ask.textContent = t("howCanIHelp");
	heading.append(hello, ask);

	const cards = document.createElement("div");
	cards.className = "prompt-cards";
	cards.setAttribute("role", "list");
	CARDS.forEach((card, index) => {
		const button = document.createElement("button");
		button.type = "button";
		button.className = "prompt-card";
		button.setAttribute("role", "listitem");
		button.style.setProperty("--i", String(index + 2));
		button.dataset.prompt = t(card.prompt);

		const glyph = icon(card.icon);
		const title = document.createElement("span");
		title.className = "prompt-card-title";
		title.textContent = t(card.title);
		const body = document.createElement("span");
		body.className = "prompt-card-body";
		body.dir = "auto";
		// The /imagine prefix is a command, not something to show.
		body.textContent = t(card.prompt).replace(/^\/imagine\s+/, "");
		button.append(glyph, title, body);
		cards.append(button);
	});

	root.append(heading, cards);
	return root;
}

/** Update the greeting in place when the user signs in or out. */
export function setGreetingName(root: ParentNode, name: string | null): void {
	const hello = root.querySelector(".empty-hello");
	if (hello) hello.textContent = name ? t("helloName", { name }) : t("hello");
}
