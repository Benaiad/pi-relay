export interface CacheEntry<T> {
	value: T;
	expiresAt: number;
}

export class TtlCache<T> {
	private store = new Map<string, CacheEntry<T>>();
	private maxSize: number;
	private defaultTtlMs: number;

	constructor(maxSize = 1000, defaultTtlMs = 300000) {
		this.maxSize = maxSize;
		this.defaultTtlMs = defaultTtlMs;
	}

	get(key: string): T | undefined {
		const entry = this.store.get(key);
		if (!entry) return undefined;
		if (Date.now() > entry.expiresAt) {
			this.store.delete(key);
			return undefined;
		}
		return entry.value;
	}

	set(key: string, value: T, ttlMs?: number): void {
		if (this.store.size >= this.maxSize) {
			this.evict();
		}
		this.store.set(key, {
			value,
			expiresAt: Date.now() + (ttlMs ?? this.defaultTtlMs),
		});
	}

	has(key: string): boolean {
		const entry = this.store.get(key);
		if (!entry) return false;
		if (Date.now() > entry.expiresAt) {
			this.store.delete(key);
			return false;
		}
		return true;
	}

	delete(key: string): boolean {
		return this.store.delete(key);
	}

	clear(): void {
		this.store.clear();
	}

	get size(): number {
		return this.store.size;
	}

	private evict(): void {
		let oldestKey: string = "";
		let oldestTime = Infinity;

		for (const [key, entry] of this.store) {
			if (entry.expiresAt < oldestTime) {
				oldestTime = entry.expiresAt;
				oldestKey = key;
			}
		}

		if (oldestKey) this.store.delete(oldestKey);
	}
}

export function parseCacheControl(header: string): { maxAge: number; noCache: boolean } {
	const result = { maxAge: 0, noCache: false };

	for (const directive of header.split(",")) {
		const trimmed = directive.trim().toLowerCase();
		if (trimmed === "no-cache" || trimmed === "no-store") {
			result.noCache = true;
		}
		if (trimmed.startsWith("max-age=")) {
			const parsed = Number(trimmed.split("=")[1]);
			if (Number.isFinite(parsed)) result.maxAge = parsed * 1000;
		}
	}

	return result;
}
