import { describe, expect, it, vi } from "vitest";
import { whenIdle } from "../scene/spline";
import { swAllowed } from "./register";

const store = (value: string | null) => ({ getItem: () => value });

describe("swAllowed", () => {
	it("registers on production-like HTTPS origins only", () => {
		expect(swAllowed({ protocol: "https:", hostname: "eleenai.xyz" }, store(null))).toBe(true);
		expect(swAllowed({ protocol: "http:", hostname: "eleenai.xyz" }, store(null))).toBe(false);
		expect(swAllowed({ protocol: "https:", hostname: "localhost" }, store(null))).toBe(false);
		expect(swAllowed({ protocol: "http:", hostname: "127.0.0.1" }, store(null))).toBe(false);
	});

	it("can be switched on locally for tests, and survives blocked storage", () => {
		expect(swAllowed({ protocol: "http:", hostname: "127.0.0.1" }, store("1"))).toBe(true);
		const blocked = {
			getItem: () => {
				throw new Error("blocked");
			},
		};
		expect(swAllowed({ protocol: "https:", hostname: "eleenai.xyz" }, blocked)).toBe(true);
		expect(swAllowed({ protocol: "http:", hostname: "127.0.0.1" }, null)).toBe(false);
	});
});

describe("whenIdle (the Spline viewer's deferral)", () => {
	function fakeWindow(readyState: string, idle: boolean) {
		const listeners = new Map<string, () => void>();
		const idleCalls: { timeout: number }[] = [];
		const win = {
			document: { readyState },
			addEventListener: (type: string, fn: () => void) => listeners.set(type, fn),
			requestAnimationFrame: (fn: () => void) => {
				fn();
				return 0;
			},
			setTimeout: (fn: () => void) => {
				fn();
				return 0;
			},
			requestIdleCallback: idle
				? (fn: () => void, options: { timeout: number }) => {
						idleCalls.push(options);
						fn();
						return 0;
					}
				: undefined,
		};
		return { win: win as unknown as Window, listeners, idleCalls };
	}

	it("waits for the load event, then asks for idle time with a timeout", () => {
		const task = vi.fn();
		const { win, listeners, idleCalls } = fakeWindow("loading", true);
		whenIdle(task, win);
		expect(task).not.toHaveBeenCalled();
		listeners.get("load")?.();
		expect(task).toHaveBeenCalledTimes(1);
		expect(idleCalls[0]?.timeout).toBeGreaterThan(0);
	});

	it("falls back to a timer where requestIdleCallback is missing", () => {
		const task = vi.fn();
		const { win } = fakeWindow("complete", false);
		whenIdle(task, win);
		expect(task).toHaveBeenCalledTimes(1);
	});
});
