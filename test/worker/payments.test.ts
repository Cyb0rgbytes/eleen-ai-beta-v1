/**
 * The payment webhook layer, with a fake provider standing in for a real
 * adapter: none exists until the owner chooses a provider.
 */
import { describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { applyPaymentEvent, handlePaymentWebhook, PaymentEvent, PaymentProvider } from "../../src/billing/webhook";
import { addCredits, balance, hold } from "../../src/lib/credits";
import { ORIGIN, send } from "./helpers";

const NOW = 1_792_600_000_000;
const db = env.DB;

let counter = 0;
const unique = (label: string) => `${label}-${++counter}`;

async function order(credits = 500, amount = 500): Promise<{ id: string; userId: string }> {
	const id = unique("order");
	const userId = unique("user");
	await db
		.prepare(
			"INSERT INTO purchases (id, user_id, provider, product, credits, amount, currency, status, created_at, updated_at) VALUES (?1, ?2, 'fake', 'starter', ?3, ?4, 'USD', 'pending', ?5, ?5)",
		)
		.bind(id, userId, credits, amount, NOW)
		.run();
	return { id, userId };
}

const event = (purchaseId: string, type: PaymentEvent["type"] = "paid", amount = 500): PaymentEvent => ({
	id: unique("event"),
	type,
	purchaseId,
	amount,
	currency: "usd",
});

const status = async (id: string) =>
	(await db.prepare("SELECT status FROM purchases WHERE id = ?1").bind(id).first<{ status: string }>())?.status;

const shortfall = async (userId: string) =>
	(await db.prepare("SELECT shortfall FROM credit_balance WHERE user_id = ?1").bind(userId).first<{ shortfall: number }>())?.shortfall;

describe("applying payment events", () => {
	it("credits a paid order once, however often it is delivered", async () => {
		const { id, userId } = await order();
		const paid = event(id);
		await applyPaymentEvent(db, "fake", paid, NOW);
		await applyPaymentEvent(db, "fake", paid, NOW);
		await applyPaymentEvent(db, "fake", event(id), NOW);
		expect(await balance(db, userId, NOW)).toBe(500);
		expect(await status(id)).toBe("paid");
	});

	it("finishes a delivery that died after crediting", async () => {
		const { id, userId } = await order();
		await addCredits(db, userId, "purchase", 500, id, null, NOW);
		await applyPaymentEvent(db, "fake", event(id), NOW);
		expect(await balance(db, userId, NOW)).toBe(500);
		expect(await status(id)).toBe("paid");
	});

	it("sets the 12-month expiry", async () => {
		const { id, userId } = await order();
		await applyPaymentEvent(db, "fake", event(id), NOW);
		const year = 365 * 24 * 60 * 60 * 1000;
		expect(await balance(db, userId, NOW + year - 1)).toBe(500);
		expect(await balance(db, userId, NOW + year)).toBe(0);
	});

	it("does not credit a payment that doesn't match the order", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const { id, userId } = await order();
		await applyPaymentEvent(db, "fake", event(id, "paid", 1), NOW);
		await applyPaymentEvent(db, "fake", { ...event(id), currency: "EUR" }, NOW);
		expect(await balance(db, userId, NOW)).toBe(0);
		expect(await status(id)).toBe("pending");
		error.mockRestore();
	});

	it("ignores an order that belongs to another provider, or none", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const { id, userId } = await order();
		await applyPaymentEvent(db, "other", event(id), NOW);
		await applyPaymentEvent(db, "fake", event("no-such-order"), NOW);
		expect(await balance(db, userId, NOW)).toBe(0);
		error.mockRestore();
	});

	it("a refund takes unspent credits back once", async () => {
		const { id, userId } = await order();
		await applyPaymentEvent(db, "fake", event(id), NOW);
		const refund = event(id, "refunded");
		await applyPaymentEvent(db, "fake", refund, NOW);
		await applyPaymentEvent(db, "fake", refund, NOW);
		await applyPaymentEvent(db, "fake", event(id, "chargeback"), NOW);
		expect(await balance(db, userId, NOW)).toBe(0);
		expect(await shortfall(userId)).toBe(0);
		expect(await status(id)).toBe("refunded");
	});

	it("a chargeback past the balance clamps, records the shortfall and blocks new holds", async () => {
		const { id, userId } = await order();
		await applyPaymentEvent(db, "fake", event(id), NOW);
		await hold(db, userId, 400, unique("job"), NOW);
		await applyPaymentEvent(db, "fake", event(id, "chargeback"), NOW);
		expect(await balance(db, userId, NOW)).toBe(0);
		expect(await shortfall(userId)).toBe(400);

		await addCredits(db, userId, "grant", 1000, unique("grant"), null, NOW);
		expect(await hold(db, userId, 1, unique("job"), NOW)).toEqual({ ok: false, reason: "insufficient" });
	});

	it("does not let a replayed payment restore a refunded order", async () => {
		const { id, userId } = await order();
		const paid = event(id);
		await applyPaymentEvent(db, "fake", paid, NOW);
		await applyPaymentEvent(db, "fake", event(id, "refunded"), NOW);
		await applyPaymentEvent(db, "fake", paid, NOW);
		expect(await balance(db, userId, NOW)).toBe(0);
		expect(await status(id)).toBe("refunded");
	});
});

describe("the webhook route", () => {
	const post = (body = "{}") => new Request(`${ORIGIN}/api/hooks/payments/fake`, { method: "POST", body });
	const provider = (verify: PaymentProvider["verify"]) => ({ fake: { verify } });

	it("has no live provider yet, on the real route", async () => {
		const response = await handlePaymentWebhook(post(), env, "fake");
		expect(response.status).toBe(404);
	});

	it("is reached signed out, above the auth gate", async () => {
		const { response } = await send("/api/hooks/payments/fake", null, { method: "POST", body: "{}" });
		expect(response.status).toBe(404);
	});

	it("does not resolve inherited names as providers", async () => {
		const response = await handlePaymentWebhook(post(), env, "constructor", {});
		expect(response.status).toBe(404);
	});

	it("refuses a delivery that fails verification, without touching the order", async () => {
		const { id, userId } = await order();
		const response = await handlePaymentWebhook(post(id), env, "fake", provider(async () => null));
		expect(response.status).toBe(401);
		expect(await balance(db, userId)).toBe(0);
	});

	it("refuses anything but POST, and an oversized body before verifying", async () => {
		const verify = vi.fn(async () => null);
		const get = new Request(`${ORIGIN}/api/hooks/payments/fake`);
		expect((await handlePaymentWebhook(get, env, "fake", provider(verify))).status).toBe(405);
		expect((await handlePaymentWebhook(post("x".repeat(300 * 1024)), env, "fake", provider(verify))).status).toBe(413);
		expect(verify).not.toHaveBeenCalled();
	});

	it("credits a verified delivery", async () => {
		const { id, userId } = await order();
		const response = await handlePaymentWebhook(post(), env, "fake", provider(async () => event(id)));
		expect(response.status).toBe(200);
		expect(await balance(db, userId)).toBe(500);
	});

	it("answers 500 to a refund overtaking its payment, so the provider retries", async () => {
		const { id, userId } = await order();
		const hooks = provider(async () => event(id, "refunded"));
		expect((await handlePaymentWebhook(post(), env, "fake", hooks)).status).toBe(500);
		expect(await status(id)).toBe("pending");
		expect(await balance(db, userId)).toBe(0);
	});
});
