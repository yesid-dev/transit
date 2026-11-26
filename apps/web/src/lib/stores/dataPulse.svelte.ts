import { browser } from '$app/env';
import { fetchCaptureSnapshot } from '#lib/live/captureSnapshot.ts';
import { dataRefresh } from './refresh.svelte';

const INTERVAL_MS = 5 * 60 * 1000;

let subscribers = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
let lifecycleWired = false;
let inFlight: Promise<void> | null = null;
let inFlightGeneration: number | null = null;
let queuedGeneration: number | null = null;
let lifecycleGeneration = 0;
let lastCheckAtMs: number | null = null;
let lastSeenMs: number | null = null;
let captureCity: string | null = null;

async function pollOnce(generation: number): Promise<void> {
	const city = captureCity;
	if (!browser || !city || generation !== lifecycleGeneration || !shouldRun()) return;
	try {
		const snapshot = await fetchCaptureSnapshot(city, AbortSignal.timeout(20_000));
		if (generation !== lifecycleGeneration || !shouldRun() || captureCity !== city) return;
		const timestamp = Date.parse(snapshot.published_at);
		const advanced = lastSeenMs !== null && timestamp > lastSeenMs;
		if (lastSeenMs === null || advanced) lastSeenMs = timestamp;
		if (advanced) dataRefresh.bumpEpoch();
	} catch {
		// A later poll can recover without replacing the last observed capture.
	}
}

function isVisible(): boolean {
	return typeof document !== 'undefined' && document.visibilityState !== 'hidden';
}

function isOnline(): boolean {
	return typeof navigator === 'undefined' || navigator.onLine !== false;
}

function shouldRun(): boolean {
	return subscribers > 0 && isVisible() && isOnline();
}

function requestPoll(): Promise<void> {
	const generation = lifecycleGeneration;
	if (inFlight) {
		if (inFlightGeneration !== generation) queuedGeneration = generation;
		return inFlight;
	}
	lastCheckAtMs = Date.now();
	const pending = pollOnce(generation);
	const tracked = pending.finally(() => {
		if (inFlight !== tracked) return;
		inFlight = null;
		inFlightGeneration = null;
		const queued = queuedGeneration;
		queuedGeneration = null;
		if (queued === lifecycleGeneration && shouldRun()) {
			void requestPoll();
			return;
		}
		if (shouldRun() && !timer) scheduleNextPoll();
	});
	inFlight = tracked;
	inFlightGeneration = generation;
	return tracked;
}

function remainingDelayMs(): number {
	if (lastCheckAtMs === null) return 0;
	return Math.max(0, INTERVAL_MS - Math.max(0, Date.now() - lastCheckAtMs));
}

function scheduleNextPoll(delayMs = remainingDelayMs()): void {
	if (!browser || !shouldRun() || timer) return;
	timer = setTimeout(() => {
		timer = null;
		void requestPoll();
	}, delayMs);
}

function startTimer(): void {
	if (!browser || !shouldRun()) return;
	if (timer) return;
	scheduleNextPoll();
}

function stopTimer(): void {
	if (timer) {
		clearTimeout(timer);
		timer = null;
	}
}

function invalidateLifecycle(): void {
	lifecycleGeneration += 1;
	queuedGeneration = null;
}

function handleLifecycleChange(): void {
	if (shouldRun()) startTimer();
	else {
		invalidateLifecycle();
		stopTimer();
	}
}

function wireLifecycle(): void {
	if (lifecycleWired || typeof document === 'undefined' || typeof window === 'undefined') return;
	lifecycleWired = true;
	document.addEventListener('visibilitychange', handleLifecycleChange);
	window.addEventListener('online', handleLifecycleChange);
	window.addEventListener('offline', handleLifecycleChange);
}

function unwireLifecycle(): void {
	if (!lifecycleWired || typeof document === 'undefined' || typeof window === 'undefined') return;
	document.removeEventListener('visibilitychange', handleLifecycleChange);
	window.removeEventListener('online', handleLifecycleChange);
	window.removeEventListener('offline', handleLifecycleChange);
	lifecycleWired = false;
}

export const dataPulse = {
	get lastSeenMs(): number | null {
		return lastSeenMs;
	},

	subscribeCapture(city: string | null): () => void {
		if (!browser || !city) return () => {};
		if (city !== captureCity) {
			invalidateLifecycle();
			stopTimer();
			captureCity = city;
			lastSeenMs = null;
			lastCheckAtMs = Date.now();
		}
		wireLifecycle();
		subscribers += 1;
		if (subscribers === 1) startTimer();
		let disposed = false;
		return () => {
			if (disposed) return;
			disposed = true;
			subscribers = Math.max(0, subscribers - 1);
			if (subscribers === 0) {
				invalidateLifecycle();
				stopTimer();
				unwireLifecycle();
			}
		};
	},

	_resetForTests(): void {
		invalidateLifecycle();
		stopTimer();
		unwireLifecycle();
		subscribers = 0;
		inFlight = null;
		inFlightGeneration = null;
		lastSeenMs = null;
		captureCity = null;
		lastCheckAtMs = null;
	},
};
