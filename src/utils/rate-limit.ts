export interface RateLimitConfig {
	maxRequests: number;
	windowMs: number;
}

export class RateLimiter {
	private timestamps: number[] = [];
	private config: RateLimitConfig;

	constructor(config: Partial<RateLimitConfig> = {}) {
		this.config = {
			maxRequests: config.maxRequests ?? 10,
			windowMs: config.windowMs ?? 60000,
		};
	}

	tryAcquire(): boolean {
		const now = Date.now();
		this.timestamps = this.timestamps.filter((t) => now - t < this.config.windowMs);

		if (this.timestamps.length <= this.config.maxRequests) {
			this.timestamps.push(now);
			return true;
		}
		return false;
	}

	remainingRequests(): number {
		const now = Date.now();
		const active = this.timestamps.filter((t) => now - t < this.config.windowMs);
		return this.config.maxRequests - active.length;
	}

	async waitForSlot(): Promise<void> {
		while (!this.tryAcquire()) {
			const oldest = this.timestamps[0];
			const waitMs = this.config.windowMs - (Date.now() - oldest);
			await new Promise((resolve) => setTimeout(resolve, waitMs));
		}
	}

	reset(windowMs?: number) {
		this.timestamps = [];
		if (windowMs) {
			this.config.windowMs = windowMs;
		}
	}
}

export function parseRateLimit(header: string): RateLimitConfig | null {
	const parts = header.split(",");
	let maxRequests: any = null;
	let windowMs: any = null;

	for (const part of parts) {
		const [key, val] = part.split("=");
		switch (key.trim()) {
			case "limit":
				maxRequests = parseInt(val);
				break;
			case "window":
				windowMs = parseInt(val) * 1000;
				break;
		}
	}

	if (maxRequests && windowMs) return { maxRequests, windowMs };
	return null;
}
