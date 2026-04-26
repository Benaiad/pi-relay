/**
 * Benchmark runner — DO NOT MODIFY.
 *
 * Runs findPrimes(N) three times, takes the best time, verifies the
 * count is correct, and writes result.json. Exits 0 on success, 1 on
 * incorrect output or crash.
 */

const N = 50_000;
const EXPECTED_COUNT = 5133;
const RUNS = 3;

let mod;
try {
	mod = require("./optimize.js");
} catch (e) {
	console.error(`CRASH: failed to load optimize.js: ${e.message}`);
	process.exit(1);
}

const { findPrimes } = mod;
if (typeof findPrimes !== "function") {
	console.error("CRASH: optimize.js does not export a findPrimes function");
	process.exit(1);
}

let bestTime = Infinity;
let count;

for (let r = 0; r < RUNS; r++) {
	let primes;
	const start = performance.now();
	try {
		primes = findPrimes(N);
	} catch (e) {
		console.error(`CRASH on run ${r + 1}: ${e.message}`);
		process.exit(1);
	}
	const elapsed = performance.now() - start;
	count = Array.isArray(primes) ? primes.length : -1;
	if (elapsed < bestTime) bestTime = elapsed;
}

const result = { time_ms: Math.round(bestTime * 100) / 100, count, n: N, correct: count === EXPECTED_COUNT };
require("fs").writeFileSync("result.json", JSON.stringify(result, null, 2));

if (!result.correct) {
	console.error(`INCORRECT: got ${count} primes up to ${N}, expected ${EXPECTED_COUNT}`);
	process.exit(1);
}

console.log(`${result.time_ms}ms | ${count} primes up to ${N}`);
