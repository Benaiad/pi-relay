import { describe, expect, it, vi } from "vitest";
import { parseCacheControl, TtlCache } from "../../src/utils/cache.js";

describe("TtlCache", () => {
	it("stores and retrieves values", () => {
		const cache = new TtlCache<string>();
		cache.set("key", "value");
		expect(cache.get("key")).toBe("value");
	});

	it("returns undefined for missing keys", () => {
		const cache = new TtlCache<string>();
		expect(cache.get("missing")).toBeUndefined();
	});

	it("expires entries based on TTL", () => {
		vi.useFakeTimers();
		const cache = new TtlCache<string>(100, 1000);
		cache.set("key", "value");
		expect(cache.get("key")).toBe("value");

		vi.advanceTimersByTime(999);
		expect(cache.get("key")).toBe("value");

		vi.advanceTimersByTime(2);
		expect(cache.get("key")).toBeUndefined();
		vi.useRealTimers();
	});

	it("has() returns false for expired entries", () => {
		vi.useFakeTimers();
		const cache = new TtlCache<string>(100, 500);
		cache.set("key", "value");

		vi.advanceTimersByTime(501);
		expect(cache.has("key")).toBe(false);
		expect(cache.get("key")).toBeUndefined();
		vi.useRealTimers();
	});

	it("has() returns true for non-expired entries", () => {
		const cache = new TtlCache<string>();
		cache.set("key", "value");
		expect(cache.has("key")).toBe(true);
	});

	it("has() returns false for missing keys", () => {
		const cache = new TtlCache<string>();
		expect(cache.has("missing")).toBe(false);
	});

	it("evicts oldest entry when max size is reached", () => {
		const cache = new TtlCache<string>(2, 10000);
		cache.set("a", "1");
		cache.set("b", "2");
		cache.set("c", "3");

		// One entry should have been evicted
		expect(cache.size).toBeLessThanOrEqual(2);
		expect(cache.get("c")).toBe("3");
	});

	it("respects ttlMs=0 as immediate expiry", () => {
		vi.useFakeTimers();
		const cache = new TtlCache<string>(100, 5000);
		cache.set("key", "value", 0);

		// Even 1ms later, it should be expired
		vi.advanceTimersByTime(1);
		expect(cache.get("key")).toBeUndefined();
		vi.useRealTimers();
	});

	it("supports delete and clear", () => {
		const cache = new TtlCache<string>();
		cache.set("a", "1");
		cache.set("b", "2");
		expect(cache.delete("a")).toBe(true);
		expect(cache.get("a")).toBeUndefined();
		cache.clear();
		expect(cache.size).toBe(0);
	});
});

describe("parseCacheControl", () => {
	it("parses max-age directive", () => {
		expect(parseCacheControl("max-age=60")).toEqual({ maxAge: 60000, noCache: false });
	});

	it("parses no-cache directive", () => {
		expect(parseCacheControl("no-cache")).toEqual({ maxAge: 0, noCache: true });
	});

	it("parses no-store directive", () => {
		expect(parseCacheControl("no-store")).toEqual({ maxAge: 0, noCache: true });
	});

	it("parses combined directives", () => {
		expect(parseCacheControl("max-age=30, no-cache")).toEqual({ maxAge: 30000, noCache: true });
	});

	it("ignores malformed max-age values", () => {
		expect(parseCacheControl("max-age=abc")).toEqual({ maxAge: 0, noCache: false });
	});

	it("returns defaults for empty string", () => {
		expect(parseCacheControl("")).toEqual({ maxAge: 0, noCache: false });
	});
});
