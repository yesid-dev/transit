/** A value a page may send already settled, or still on its way. */
export type Awaitable<T> = T | Promise<T>;

/** Page data where every promise may already be its value (see readyAnswers). */
export type Ready<T> =
	T extends Promise<infer V>
		? Awaitable<V>
		: T extends
					| string
					| number
					| boolean
					| bigint
					| symbol
					| ((...args: never[]) => unknown)
					| Date
					| Map<unknown, unknown>
					| Set<unknown>
					| URL
					| RegExp
			? T
			: T extends object
				? { [K in keyof T]: Ready<T[K]> }
				: T;

/** Whether a page value has already settled (it came drawn on the server). */
export function isSettled<T>(value: Awaitable<T>): value is T {
	return !(
		value instanceof Promise ||
		(typeof value === 'object' &&
			value !== null &&
			typeof Reflect.get(value, 'then') === 'function')
	);
}

/** Results the page asks again for (record recovery): they always stay promises. */
export const WAITING_KINDS: ReadonlySet<string> = new Set(['busy', 'timeout']);

export function isWaitingResult(value: unknown) {
	return (
		typeof value === 'object' &&
		value !== null &&
		WAITING_KINDS.has(String(Reflect.get(value, 'kind')))
	);
}

/**
 * Combines page values like `Promise.all`, but returns the combination itself when every value has
 * already settled, so the server can draw it.
 */
export function whenAll<const T extends readonly unknown[], R>(
	values: T,
	combine: (settled: { -readonly [K in keyof T]: Awaited<T[K]> }) => R,
): Awaitable<R> {
	return values.every((value) => isSettled(value))
		? combine(values as unknown as { -readonly [K in keyof T]: Awaited<T[K]> })
		: Promise.all(values).then((settled) =>
				combine(settled as unknown as { -readonly [K in keyof T]: Awaited<T[K]> }),
			);
}
