/**
 * Minimal `Result<T, E>` helper.
 *
 * Used in place of throwing for any operation whose failure is a first-class
 * domain outcome the caller must handle. The compiler returns `Result`, the
 * actor engine returns `Result`, the artifact store returns `Result`. Throwing
 * is reserved for programmer errors (invariant violations, bad invariants
 * detected in tests).
 */

export type Result<T, E> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });

export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });

export const isOk = <T, E>(result: Result<T, E>): result is { ok: true; value: T } => result.ok;

export const isErr = <T, E>(result: Result<T, E>): result is { ok: false; error: E } => !result.ok;

/** Apply `fn` to the value of a successful result; pass errors through unchanged. */
export const mapResult = <T, U, E>(result: Result<T, E>, fn: (value: T) => U): Result<U, E> =>
	result.ok ? ok(fn(result.value)) : result;

/** Chain another fallible operation on a successful result; pass errors through unchanged. */
export const flatMapResult = <T, U, E>(result: Result<T, E>, fn: (value: T) => Result<U, E>): Result<U, E> =>
	result.ok ? fn(result.value) : result;
