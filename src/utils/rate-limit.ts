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

		if (this.timestamps.length < this.config.maxRequests) {
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
			const oldest = this.timestamps[0]!;
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
	let maxRequests: number | null = null;
	let windowMs: number | null = null;

	for (const part of parts) {
		const eqIdx = part.indexOf("=");
		if (eqIdx === -1) continue;
		const key = part.substring(0, eqIdx).trim();
		const val = part.substring(eqIdx + 1);
		switch (key) {
			case "limit": {
				const parsed = parseInt(val, 10);
				if (!Number.isNaN(parsed)) maxRequests = parsed;
				break;
			}
			case "window": {
				const parsed = parseInt(val, 10);
				if (!Number.isNaN(parsed)) windowMs = parsed * 1000;
				break;
			}
		}
	}

	if (maxRequests !== null && windowMs !== null) return { maxRequests, windowMs };
	return null;
}
