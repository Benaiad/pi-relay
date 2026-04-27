import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { debounce, throttle } from "../../src/utils/debounce.js";

describe("debounce", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("delays execution and only fires the last call", () => {
		const fn = vi.fn();
		const debounced = debounce(fn, 100);

		debounced("a");
		debounced("b");
		debounced("c");

		expect(fn).not.toHaveBeenCalled();

		vi.advanceTimersByTime(100);

		expect(fn).toHaveBeenCalledTimes(1);
		expect(fn).toHaveBeenCalledWith("c");
	});

	it("resets the timer on re-entry", () => {
		const fn = vi.fn();
		const debounced = debounce(fn, 100);

		debounced("first");
		vi.advanceTimersByTime(50);
		debounced("second");
		vi.advanceTimersByTime(50);

		expect(fn).not.toHaveBeenCalled();

		vi.advanceTimersByTime(50);

		expect(fn).toHaveBeenCalledTimes(1);
		expect(fn).toHaveBeenCalledWith("second");
	});

	it("fires immediately with zero delay", () => {
		const fn = vi.fn();
		const debounced = debounce(fn, 0);

		debounced("a");
		vi.advanceTimersByTime(0);

		expect(fn).toHaveBeenCalledTimes(1);
		expect(fn).toHaveBeenCalledWith("a");
	});
});

describe("throttle", () => {
	it("limits calls within the interval", () => {
		const fn = vi.fn();
		const throttled = throttle(fn, 100);

		throttled("a");
		throttled("b");
		throttled("c");

		expect(fn).toHaveBeenCalledTimes(1);
		expect(fn).toHaveBeenCalledWith("a");
	});

	it("allows calls after the interval elapses", () => {
		const fn = vi.fn();
		vi.useFakeTimers();
		const throttled = throttle(fn, 100);

		throttled("first");
		expect(fn).toHaveBeenCalledTimes(1);

		vi.advanceTimersByTime(100);
		throttled("second");
		expect(fn).toHaveBeenCalledTimes(2);
		expect(fn).toHaveBeenCalledWith("second");

		vi.useRealTimers();
	});

	it("fires on every call with zero interval", () => {
		const fn = vi.fn();
		const throttled = throttle(fn, 0);

		throttled("a");
		throttled("b");
		throttled("c");

		expect(fn).toHaveBeenCalledTimes(3);
	});
});
