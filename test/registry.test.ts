import { describe, expect, it } from "vitest";
import {
	DEFAULT_MODEL,
	MODELS,
	canUse,
	defaultForTier,
	modelIdentifiers,
	outputCap,
	resolveModel,
} from "../src/ai/registry";

describe("registry", () => {
	it("pins the Fast default to the model v1 clients have always had", () => {
		expect(DEFAULT_MODEL.id).toBe("@cf/meta/llama-3.1-8b-instruct-fp8");
		expect(DEFAULT_MODEL.maxTokens.guest).toBe(512);
		expect(DEFAULT_MODEL.maxTokens.user).toBe(1024);
	});

	it("has an owner-billed model for every tier", () => {
		for (const tier of ["fast", "smart", "reasoning"] as const) {
			const spec = defaultForTier(tier);
			expect(spec.tier).toBe(tier);
			expect(spec.billing).toBe("owner");
			expect(spec.provider).toBe("workers-ai");
		}
	});

	it("has unique ids", () => {
		const ids = MODELS.map((m) => m.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	describe("resolveModel", () => {
		it("defaults when nothing is sent", () => {
			expect(resolveModel(undefined)).toBe(DEFAULT_MODEL);
			expect(resolveModel(null)).toBe(DEFAULT_MODEL);
			expect(resolveModel("")).toBe(DEFAULT_MODEL);
		});

		it("accepts a tier name", () => {
			expect(resolveModel("smart")?.tier).toBe("smart");
			expect(resolveModel("reasoning")?.reasoning).toBe("think-tags");
		});

		it("accepts a full id", () => {
			expect(resolveModel("@cf/meta/llama-3.3-70b-instruct-fp8-fast")?.label).toBe("Llama 3.3 70B");
		});

		it("rejects anything the registry does not know", () => {
			expect(resolveModel("@cf/meta/llama-9000")).toBeNull();
			expect(resolveModel("../../etc/passwd")).toBeNull();
			expect(resolveModel(42)).toBeNull();
			expect(resolveModel({ id: "fast" })).toBeNull();
		});
	});

	describe("canUse", () => {
		it("lets guests and users run owner-billed models", () => {
			expect(canUse(defaultForTier("fast"), "guest")).toBe(true);
			expect(canUse(defaultForTier("smart"), "guest")).toBe(true);
			expect(canUse(defaultForTier("reasoning"), "user_1")).toBe(true);
		});

		it("keeps the reasoning tier for signed-in users", () => {
			expect(canUse(defaultForTier("reasoning"), "guest")).toBe(false);
		});

		it("keeps user-key models away from guests; signed-in users still need a key", () => {
			const premium = MODELS.find((m) => m.billing === "user-key")!;
			expect(canUse(premium, "guest")).toBe(false);
			expect(canUse(premium, "user_1")).toBe(true);
		});
	});

	describe("outputCap", () => {
		it("is the model's own cap for the caller's tier", () => {
			expect(outputCap(DEFAULT_MODEL, "guest")).toBe(512);
			expect(outputCap(DEFAULT_MODEL, "user_1")).toBe(1024);
			expect(outputCap(defaultForTier("reasoning"), "user_1")).toBe(4096);
		});

		it("lets a ceiling lower it but never raise it", () => {
			expect(outputCap(DEFAULT_MODEL, "user_1", 300)).toBe(300);
			expect(outputCap(DEFAULT_MODEL, "user_1", 9000)).toBe(1024);
		});
	});

	it("exposes every id lowercased for the guard", () => {
		const ids = modelIdentifiers();
		expect(ids).toContain("@cf/meta/llama-3.1-8b-instruct-fp8");
		expect(ids.every((id) => id === id.toLowerCase())).toBe(true);
	});
});
