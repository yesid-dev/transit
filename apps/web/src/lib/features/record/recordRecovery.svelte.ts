import { untrack } from 'svelte';
import { beforeNavigate } from '$app/navigation';
import { SvelteMap, SvelteSet, SvelteURLSearchParams } from 'svelte/reactivity';
import type { DateWindow } from '#lib/v1/history/window.ts';
import { getRecordRecovered, getRecordRetry } from './recordPatience.ts';
import { readingPaths, withReadings, type RecoveryScreen } from './recordReadings.ts';

/** After the page's readings settle: ask again after about 5 s, then 15 s, then stop. */
export const RECOVERY_DELAYS_MS = [5_000, 15_000];
/** "Try again" asks at once, then follows the same steps. */
const TRY_AGAIN_DELAYS_MS = [0, ...RECOVERY_DELAYS_MS];
const RECOVERY_REQUEST_MS = 50_000;
const RECOVERY_READING_LIMIT = 20;

export type RecoveryQuery = DateWindow & {
	screen: RecoveryScreen;
	city: string;
	id?: string;
	lang?: 'en' | 'fr';
	/** The page's own address parameters (direction, list view, ranking choice). */
	page?: string;
};

type Settled = { kind?: unknown } | null | undefined;
const waitingKinds = new Set(['busy', 'timeout']);
const isWaiting = (result: Settled) => waitingKinds.has(String(result?.kind));

/**
 * Asks a screen's readings again when the engine or the visitor limit said "busy": cards that
 * wait show "Waiting for a turn. This card asks again in a few seconds." while it asks; after the last try they show the honest
 * end state, and the screen offers one "Try again" for all of them. Answered readings keep their
 * place: only the missing ones are asked and replaced. A navigation, such as a screen's own
 * "Try again" that reloads its data, stops any automatic ask until it completes: the screen asks
 * once, never twice.
 */
export function recoverReadings<T extends object>(
	getRoot: () => T | null | undefined,
	getQuery: (root: T) => RecoveryQuery | null,
) {
	const recordRecovered = getRecordRecovered();
	const registerRetry = getRecordRetry();
	let recovered = $state.raw<{
		initial: T;
		answers: ReadonlyMap<string, PromiseLike<unknown>>;
	} | null>(null);
	let navigating = false;
	let pause: (() => void) | undefined;
	let resume: (() => void) | undefined;

	beforeNavigate(({ from, to, complete }) => {
		// A jump to a place on the same page reloads nothing.
		const sameDocument =
			from && to && from.url.pathname === to.url.pathname && from.url.search === to.url.search;
		if (sameDocument && from.url.hash !== to.url.hash) return;
		navigating = true;
		pause?.();
		void complete
			.catch(() => {})
			.finally(() => {
				navigating = false;
				resume?.();
			});
	});

	$effect(() => {
		const current = getRoot();
		// The query is read once for the readings it belongs to: an address change alone asks nothing.
		const query = current && untrack(() => getQuery(current));
		if (!current || !query) return;
		const initial: T = current;
		const readings = readingPaths(initial);
		if (!readings.size) return;

		const controller = new AbortController();
		const waiting = new SvelteSet<string>();
		const failed = new SvelteSet<string>();
		const answers = new SvelteMap<string, PromiseLike<unknown>>();
		let timer: ReturnType<typeof setTimeout> | undefined;
		let delays = RECOVERY_DELAYS_MS;
		let attempt = 0;
		let eligibleAt = Infinity;
		let inFlight = false;
		let flight: AbortController | undefined;
		let releaseRetry: (() => void) | undefined;

		function publish() {
			recovered = { initial, answers: new SvelteMap(answers) };
		}

		async function read(paths: string[]) {
			const params = new SvelteURLSearchParams({
				screen: query!.screen,
				city: query!.city,
				from: query!.from,
				to: query!.to,
				readings: paths.join(','),
			});
			if (query!.id) params.set('id', query!.id);
			if (query!.lang) params.set('lang', query!.lang);
			if (query!.page) params.set('page', query!.page);
			try {
				const signal = AbortSignal.any([
					controller.signal,
					flight!.signal,
					AbortSignal.timeout(RECOVERY_REQUEST_MS),
				]);
				const response = await fetch(`/api/record-recovery?${params}`, { signal });
				if (!response.ok) return;
				const results: Record<string, Settled> = await response.json();
				if (signal.aborted) return;
				for (const [path, result] of Object.entries(results)) {
					// Readings that come with another (stop names with their ranking) replace theirs.
					if (!readings.has(path) || isWaiting(result)) continue;
					if (waiting.delete(path) && result?.kind === 'unreachable') failed.add(path);
					answers.set(path, Promise.resolve(result));
				}
				if (!waiting.size) recordRecovered?.();
				publish();
			} catch {
				// The next step also covers transport failures and incomplete responses.
			}
		}

		function tryAgain() {
			if (controller.signal.aborted) return;
			releaseRetry?.();
			releaseRetry = undefined;
			const paths = [...failed];
			failed.clear();
			for (const path of paths) {
				waiting.add(path);
				answers.set(path, Promise.resolve({ kind: 'busy' }));
			}
			publish();
			delays = TRY_AGAIN_DELAYS_MS;
			attempt = 0;
			eligibleAt = Date.now() + delays[attempt++];
			schedule();
		}

		function offerTryAgain() {
			if (failed.size && !releaseRetry) releaseRetry = registerRetry?.(tryAgain);
		}

		function giveUp() {
			for (const path of waiting) {
				failed.add(path);
				answers.set(path, Promise.resolve({ kind: 'unreachable' }));
			}
			waiting.clear();
			publish();
			offerTryAgain();
		}

		async function recover() {
			if (document.hidden || controller.signal.aborted || navigating) return;
			inFlight = true;
			flight = new AbortController();
			const paths = [...waiting];
			const batches = [];
			for (let index = 0; index < paths.length; index += RECOVERY_READING_LIMIT) {
				batches.push(read(paths.slice(index, index + RECOVERY_READING_LIMIT)));
			}
			await Promise.all(batches);
			inFlight = false;
			if (controller.signal.aborted || flight.signal.aborted) return;
			if (!waiting.size) return offerTryAgain();
			const delay = delays[attempt++];
			if (delay === undefined) return giveUp();
			eligibleAt = Date.now() + delay;
			schedule();
		}

		function schedule() {
			clearTimeout(timer);
			if (inFlight || navigating || controller.signal.aborted || document.hidden || !waiting.size)
				return;
			timer = setTimeout(() => void recover(), Math.max(0, eligibleAt - Date.now()));
		}
		document.addEventListener('visibilitychange', schedule);
		pause = () => {
			clearTimeout(timer);
			flight?.abort();
		};
		resume = () => {
			// The navigation kept these readings: start their steps again, never at once.
			if (!waiting.size) return;
			attempt = 0;
			delays = RECOVERY_DELAYS_MS;
			eligibleAt = Date.now() + delays[attempt++];
			schedule();
		};

		const settled = [...readings].map(async ([path, reading]) => {
			try {
				return [path, (await reading) as Settled] as const;
			} catch {
				return [path, null] as const;
			}
		});
		void Promise.all(settled).then((results) => {
			if (controller.signal.aborted) return;
			for (const [path, result] of results) {
				if (!isWaiting(result)) continue;
				waiting.add(path);
				// A reading cut at its limit waits like a busy one while it is asked again.
				if (result?.kind === 'timeout') answers.set(path, Promise.resolve({ kind: 'busy' }));
			}
			if (!waiting.size) return;
			if (answers.size) publish();
			eligibleAt = Date.now() + delays[attempt++];
			schedule();
		});
		return () => {
			controller.abort();
			clearTimeout(timer);
			pause = resume = undefined;
			releaseRetry?.();
			document.removeEventListener('visibilitychange', schedule);
		};
	});

	return () => {
		const current = getRoot();
		if (!current || recovered?.initial !== current) return current;
		return withReadings(current, recovered.answers);
	};
}
