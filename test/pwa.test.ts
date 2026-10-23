import { describe, expect, it } from "vitest";
import { isPwaPath, withPwaHeaders } from "../src/lib/pwa";

const asset = (type: string, status = 200) => new Response(status === 200 ? "x" : null, { status, headers: { "Content-Type": type } });

describe("withPwaHeaders", () => {
	it("serves the manifest as application/manifest+json, cached for an hour", () => {
		const response = withPwaHeaders("/manifest.webmanifest", asset("application/octet-stream"));
		expect(response.headers.get("Content-Type")).toBe("application/manifest+json; charset=utf-8");
		expect(response.headers.get("Cache-Control")).toBe("public, max-age=3600");
	});

	it("revalidates the service worker and its offline page on every load", () => {
		const sw = withPwaHeaders("/sw.js", asset("application/javascript"));
		expect(sw.headers.get("Content-Type")).toBe("text/javascript; charset=utf-8");
		expect(sw.headers.get("Cache-Control")).toBe("no-cache");
		const offline = withPwaHeaders("/offline", asset("text/html"));
		expect(offline.headers.get("Content-Type")).toBe("text/html");
		expect(offline.headers.get("Cache-Control")).toBe("no-cache");
	});

	it("leaves errors and other paths alone", () => {
		const missing = asset("text/plain", 404);
		expect(withPwaHeaders("/sw.js", missing)).toBe(missing);
		const other = asset("image/png");
		expect(withPwaHeaders("/logo.png", other)).toBe(other);
		expect(isPwaPath("/sw.js")).toBe(true);
		expect(isPwaPath("/api/v1/health")).toBe(false);
		expect(isPwaPath("/toString")).toBe(false);
	});
});
