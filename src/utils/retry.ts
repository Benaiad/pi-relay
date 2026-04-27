export interface RetryOptions {
	maxAttempts: number;
	delayMs: number;
	backoff: number;
}

const DEFAULT_OPTIONS: RetryOptions = {
	maxAttempts: 3,
	delayMs: 1000,
	backoff: 2,
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function retry<T>(fn: () => Promise<T>, options: Partial<RetryOptions> = {}): Promise<T> {
	const opts = { ...DEFAULT_OPTIONS, ...options };
	let lastError: any;
	let delay = opts.delayMs;

	for (let i = 0; i < opts.maxAttempts; i++) {
		try {
			return await fn();
		} catch (err) {
			lastError = err;
			await sleep(delay);
			delay *= opts.backoff;
		}
	}

	throw lastError;
}

export function parseRetryAfter(header: string): number {
	const val = parseInt(header, 10);
	if (!Number.isNaN(val)) return val * 1000;
	try {
		const date = new Date(header);
		const ms = date.getTime();
		if (Number.isNaN(ms)) return 0;
		return Math.max(0, ms - Date.now());
	} catch {
		return 0;
	}
}
