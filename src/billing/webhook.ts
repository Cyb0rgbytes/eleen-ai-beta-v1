/**
 * Payment webhooks, whichever provider sends them.
 *
 * A provider adapter only proves a delivery is genuine and says what it
 * means. Everything that moves credits is here, so choosing a provider adds
 * one adapter and changes nothing about how money is handled. PROVIDERS is
 * empty until one is chosen, so every delivery is a 404.
 *
 * The route sits above the auth gate (src/index.ts): the sender has no user,
 * and the signature is its authentication. It also skips the rate limit, whose
 * burst guard would count every customer's payment as one caller.
 *
 * Which user is credited, and how much, comes from our own pending purchase.
 * The delivery only names it, so nothing in provider metadata can credit the
 * wrong account or the wrong amount. Steps are idempotent, so a failed
 * delivery answers 500 and the provider's retry finishes the job.
 */
import { Env } from "../types";
import { readCapped, TooLarge } from "../lib/body";
import { addCredits, reverseCredits } from "../lib/credits";

export const WEBHOOK_PREFIX = "/api/hooks/payments/";

/** Far above any real delivery; these bodies are read before being verified. */
const MAX_BODY_BYTES = 256 * 1024;

/** Terms: pack credits last 12 months, extended by each purchase. */
const CREDIT_LIFETIME_MS = 365 * 24 * 60 * 60 * 1000;

export interface PaymentEvent {
	/** The provider's id for this event. */
	id: string;
	type: "paid" | "refunded" | "chargeback";
	/** Our purchases.id, passed to the provider at checkout. */
	purchaseId: string;
	/** Minor units of currency. Only checked on "paid". */
	amount: number;
	currency: string;
}

export interface PaymentProvider {
	/** The event, or null when the delivery isn't provably from the provider. Must not parse before verifying. */
	verify(body: Uint8Array, headers: Headers, env: Env): Promise<PaymentEvent | null>;
}

/** Keyed by the provider's name in the webhook URL and in purchases.provider. */
const PROVIDERS: Record<string, PaymentProvider> = {};

interface PurchaseRow {
	id: string;
	user_id: string;
	credits: number;
	amount: number;
	currency: string;
	status: "pending" | "paid" | "refunded" | "chargeback";
}

const setStatus = (db: D1Database, id: string, status: string, now: number) =>
	db.prepare("UPDATE purchases SET status = ?2, updated_at = ?3 WHERE id = ?1").bind(id, status, now).run();

/** Thrown when a delivery can't apply yet, so the provider retries it. */
class OutOfOrder extends Error {}

export async function applyPaymentEvent(db: D1Database, provider: string, event: PaymentEvent, now = Date.now()): Promise<void> {
	const purchase = await db
		.prepare("SELECT id, user_id, credits, amount, currency, status FROM purchases WHERE id = ?1 AND provider = ?2")
		.bind(event.purchaseId, provider)
		.first<PurchaseRow>();

	// Genuine, but no order of ours: retrying can't change that.
	if (!purchase) {
		console.error("Payment event for an unknown purchase", { provider, event: event.id });
		return;
	}

	if (event.type === "paid") {
		if (purchase.status === "pending") {
			if (event.amount !== purchase.amount || event.currency.toLowerCase() !== purchase.currency.toLowerCase()) {
				console.error("Payment amount does not match the order", { provider, event: event.id });
				return;
			}
			await addCredits(db, purchase.user_id, "purchase", purchase.credits, purchase.id, now + CREDIT_LIFETIME_MS, now);
			await setStatus(db, purchase.id, "paid", now);
		}
	} else {
		// A refund overtaking its own payment: wait for the payment.
		if (purchase.status === "pending") throw new OutOfOrder();
		// One reversal per order. A chargeback after a refund has nothing left to take.
		if (purchase.status === "paid") {
			const kind = event.type === "refunded" ? "refund" : "chargeback";
			await reverseCredits(db, purchase.user_id, kind, purchase.credits, purchase.id, now);
			await setStatus(db, purchase.id, event.type, now);
		}
	}

	await db
		.prepare("INSERT INTO payment_events (provider, event_id, received_at) VALUES (?1, ?2, ?3) ON CONFLICT DO NOTHING")
		.bind(provider, event.id, now)
		.run();
}

export async function handlePaymentWebhook(
	request: Request,
	env: Env,
	name: string,
	providers: Record<string, PaymentProvider> = PROVIDERS,
): Promise<Response> {
	// Own keys only: a name like "constructor" must not resolve to anything.
	const provider = Object.prototype.hasOwnProperty.call(providers, name) ? providers[name] : undefined;
	if (!provider) return new Response("Not found", { status: 404 });
	if (request.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } });

	let body: Uint8Array;
	try {
		body = await readCapped(request, MAX_BODY_BYTES);
	} catch (error) {
		if (error instanceof TooLarge) return new Response(null, { status: 413 });
		throw error;
	}

	const event = await provider.verify(body, request.headers, env);
	if (!event) return new Response(null, { status: 401 });

	try {
		await applyPaymentEvent(env.DB, name, event);
	} catch (error) {
		if (!(error instanceof OutOfOrder)) {
			console.error("Payment event failed:", error instanceof Error ? error.message : "unknown");
		}
		return new Response(null, { status: 500 });
	}
	return new Response(null, { status: 200 });
}
