/**
 * A screen's readings are the promises in its page data, found by where they sit: `crowding`,
 * `sections.byLine` (a section is named by its `section`), `scorecard.poll_success`. The server
 * finds the same places in its own readers, so a reading asked again lands where it came from.
 */

export const recoveryScreens = [
	'overview',
	'lines',
	'line',
	'stops',
	'stop',
	'vehicles',
	'vehicle',
	'network',
	'rankings',
	'alerts',
	'status',
	'receipt',
	'departure',
] as const;

export type RecoveryScreen = (typeof recoveryScreens)[number];

export const READING_PATH = /^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)?$/;
const MAX_DEPTH = 3;

function isReading(value: unknown): value is PromiseLike<unknown> {
	return typeof (value as PromiseLike<unknown> | null)?.then === 'function';
}

function isPlain(value: unknown): value is Record<string, unknown> | unknown[] {
	if (value == null || typeof value !== 'object') return false;
	const prototype = Object.getPrototypeOf(value);
	return Array.isArray(value) || prototype === Object.prototype || prototype === null;
}

function sectionName(item: unknown) {
	const { section, answer } = (item ?? {}) as { section?: unknown; answer?: unknown };
	return typeof section === 'string' && isReading(answer) ? section : null;
}

/** Every reading under `root`, by its place. */
export function readingPaths(root: unknown) {
	const found = new Map<string, PromiseLike<unknown>>();
	function visit(value: unknown, path: string[]) {
		if (isReading(value)) {
			if (path.length) found.set(path.join('.'), value);
			return;
		}
		if (!isPlain(value) || path.length >= MAX_DEPTH) return;
		if (Array.isArray(value)) {
			value.forEach((item, index) => {
				const section = sectionName(item);
				if (section) found.set([...path, section].join('.'), (item as { answer: never }).answer);
				else visit(item, [...path, String(index)]);
			});
			return;
		}
		for (const [key, child] of Object.entries(value)) visit(child, [...path, key]);
	}
	visit(root, []);
	return found;
}

/** The reading's own name: the last part of its place. */
export function readingName(path: string) {
	return path.slice(path.lastIndexOf('.') + 1);
}

/** A copy of `root` with the readings at the given places replaced; nothing else is copied. */
export function withReadings<T>(root: T, replaced: ReadonlyMap<string, PromiseLike<unknown>>): T {
	if (!replaced.size) return root;
	function rebuild(value: unknown, path: string[]): unknown {
		if (isReading(value)) return replaced.get(path.join('.')) ?? value;
		if (!isPlain(value) || path.length >= MAX_DEPTH) return value;
		const inside = (key: string) => {
			const prefix = [...path, key].join('.');
			for (const place of replaced.keys())
				if (place === prefix || place.startsWith(`${prefix}.`)) return true;
			return false;
		};
		if (Array.isArray(value)) {
			let changed = false;
			const items = value.map((item, index) => {
				const section = sectionName(item);
				if (section) {
					const answer = replaced.get([...path, section].join('.'));
					if (!answer) return item;
					changed = true;
					return { ...(item as object), answer };
				}
				if (!inside(String(index))) return item;
				changed = true;
				return rebuild(item, [...path, String(index)]);
			});
			return changed ? items : value;
		}
		let copy: Record<string, unknown> | null = null;
		for (const [key, child] of Object.entries(value)) {
			if (!inside(key)) continue;
			copy ??= { ...value };
			copy[key] = rebuild(child, [...path, key]);
		}
		return copy ?? value;
	}
	return rebuild(root, []) as T;
}
