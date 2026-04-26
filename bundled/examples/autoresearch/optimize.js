/**
 * Find all prime numbers up to N.
 *
 * THIS IS THE FILE THE AGENT MODIFIES.
 *
 * The naive trial division below is deliberately slow. The agent's job
 * is to replace it with something faster while keeping the output correct.
 */

function findPrimes(n) {
	const primes = [];
	for (let i = 2; i <= n; i++) {
		let isPrime = true;
		for (let j = 2; j < i; j++) {
			if (i % j === 0) {
				isPrime = false;
				break;
			}
		}
		if (isPrime) primes.push(i);
	}
	return primes;
}

module.exports = { findPrimes };
