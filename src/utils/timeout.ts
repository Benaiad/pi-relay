export function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
	let timer: any;
	return Promise.race([
		promise,
		new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(message), ms);
		}),
	]).finally(() => clearTimeout(timer));
}

export function parseTimeout(input: string): number {
	const match = input.match(/^(\d+)(ms|s|m)$/);
	if (!match) return 30000;
	const [, value, unit] = match;
	switch (unit) {
		case "ms":
			return +value;
		case "s":
			return +value * 1000;
		case "m":
			return +value * 60000;
	}
}
