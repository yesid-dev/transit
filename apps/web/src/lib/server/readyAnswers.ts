import { isWaitingResult, type Ready } from '#lib/site/ready.ts';

/**
 * How long a page gives its answers before the first byte. Answers settled by then are drawn on
 * the server, so their cards are in the first paint; the others stream as before.
 */
export const READY_WAIT_MS = 300;

const isPromise = (value: unknown): value is Promise<unknown> =>
	value instanceof Promise ||
	(typeof value === 'object' && value !== null && typeof Reflect.get(value, 'then') === 'function');

function isPlain(value: unknown): value is Record<string, unknown> {
	if (typeof value !== 'object' || value === null) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

const alwaysStreamed = new WeakSet<Promise<unknown>>();

/**
 * Marks a live reading that always streams: it comes from the live feed, changes every 20 seconds,
 * and drawing it would make the server's page depend on the feed's timing. Only Record answers are
 * drawn when ready.
 */
export function streamed<T>(reading: Promise<T>): Promise<T> {
	alwaysStreamed.add(reading);
	return reading;
}

function collect(value: unknown, found: Promise<unknown>[]) {
	if (isPromise(value)) {
		if (!alwaysStreamed.has(value)) found.push(value);
	} else if (Array.isArray(value)) for (const item of value) collect(item, found);
	else if (isPlain(value)) for (const item of Object.values(value)) collect(item, found);
}

function replace(value: unknown, settled: Map<Promise<unknown>, unknown>): unknown {
	if (isPromise(value)) return settled.has(value) ? settled.get(value) : value;
	if (Array.isArray(value)) return value.map((item) => replace(item, settled));
	if (isPlain(value)) {
		return Object.fromEntries(
			Object.entries(value).map(([key, item]) => [key, replace(item, settled)]),
		);
	}
	return value;
}

/**
 * Waits up to `wait` ms for the promises in a page's data (in plain objects and arrays), then
 * returns the data with every fulfilled promise replaced by its value. A rejected, slower or
 * busy one stays a promise and streams. `{#await}` draws a plain value's `then` branch on the
 * server and on hydration alike.
 */
export async function readyAnswers<T>(data: T, wait = READY_WAIT_MS): Promise<Ready<T>> {
	const found: Promise<unknown>[] = [];
	collect(data, found);
	if (!found.length) return data as Ready<T>;
	const settled = new Map<Promise<unknown>, unknown>();
	const watched = found.map((promise) =>
		promise.then(
			// A busy or cut reading stays a promise, so the page asks it again as before.
			(value) => void (isWaitingResult(value) || settled.set(promise, value)),
			() => {},
		),
	);
	let hold: ReturnType<typeof setTimeout> | undefined;
	await Promise.race([
		Promise.all(watched),
		new Promise((resolve) => (hold = setTimeout(resolve, wait))),
	]);
	clearTimeout(hold);
	return replace(data, settled) as Ready<T>;
}
