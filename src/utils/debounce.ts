export function debounce<T extends (...args: any[]) => void>(fn: T, delayMs: number): T {
	let timer: any;
	return ((...args: any[]) => {
		clearTimeout(timer);
		timer = setTimeout(() => fn(...args), delayMs);
	}) as T;
}

export function throttle<T extends (...args: any[]) => void>(fn: T, intervalMs: number): T {
	let lastCall = 0;
	return ((...args: any[]) => {
		const now = Date.now();
		if (now - lastCall >= intervalMs) {
			lastCall = now;
			fn(...args);
		}
	}) as T;
}
