import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('$app/env', () => ({ browser: true }));

const mocks = vi.hoisted(() => ({
	fetchCaptureSnapshot: vi.fn(),
	bumpEpoch: vi.fn(),
}));
vi.mock('#lib/live/captureSnapshot.ts', () => ({
	fetchCaptureSnapshot: mocks.fetchCaptureSnapshot,
}));
vi.mock('./refresh.svelte', () => ({ dataRefresh: { bumpEpoch: mocks.bumpEpoch } }));

import { dataPulse } from './dataPulse.svelte';

const discoveryInterval = 5 * 60 * 1_000;
const first = '2026-11-23T12:00:00Z';
const next = '2026-11-23T12:00:20Z';
const older = '2026-11-23T11:59:59Z';
let visibility: DocumentVisibilityState;

beforeEach(() => {
	vi.useFakeTimers();
	dataPulse._resetForTests();
	mocks.bumpEpoch.mockReset();
	mocks.fetchCaptureSnapshot.mockReset().mockResolvedValue({ published_at: first });
	visibility = 'visible';
	vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
	vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
});
afterEach(() => {
	dataPulse._resetForTests();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

it('waits for a city and the discovery interval before reading the capture', async () => {
	dataPulse.subscribeCapture(null);
	await vi.advanceTimersByTimeAsync(discoveryInterval);
	expect(mocks.fetchCaptureSnapshot).not.toHaveBeenCalled();
	dataPulse.subscribeCapture('stm');
	await vi.advanceTimersByTimeAsync(discoveryInterval - 1);
	expect(mocks.fetchCaptureSnapshot).not.toHaveBeenCalled();
	await vi.advanceTimersByTimeAsync(1);
	expect(mocks.fetchCaptureSnapshot).toHaveBeenCalledExactlyOnceWith(
		'stm',
		expect.any(AbortSignal),
	);
	expect(dataPulse.lastSeenMs).toBe(Date.parse(first));
	expect(mocks.bumpEpoch).not.toHaveBeenCalled();
});

it('advances only when the published capture time increases', async () => {
	dataPulse.subscribeCapture('stm');
	await vi.advanceTimersByTimeAsync(discoveryInterval);
	mocks.fetchCaptureSnapshot.mockResolvedValueOnce({ published_at: older });
	await vi.advanceTimersByTimeAsync(discoveryInterval * 2);
	expect(mocks.bumpEpoch).not.toHaveBeenCalled();
	mocks.fetchCaptureSnapshot.mockResolvedValueOnce({ published_at: next });
	await vi.advanceTimersByTimeAsync(discoveryInterval);
	expect(dataPulse.lastSeenMs).toBe(Date.parse(next));
	expect(mocks.bumpEpoch).toHaveBeenCalledOnce();
});

it('pauses when hidden and resumes at the remaining discovery interval', async () => {
	dataPulse.subscribeCapture('stm');
	await vi.advanceTimersByTimeAsync(30_000);
	visibility = 'hidden';
	document.dispatchEvent(new Event('visibilitychange'));
	await vi.advanceTimersByTimeAsync(30_000);
	visibility = 'visible';
	document.dispatchEvent(new Event('visibilitychange'));
	await vi.advanceTimersByTimeAsync(discoveryInterval - 60_000 - 1);
	expect(mocks.fetchCaptureSnapshot).not.toHaveBeenCalled();
	await vi.advanceTimersByTimeAsync(1);
	expect(mocks.fetchCaptureSnapshot).toHaveBeenCalledOnce();
});

it('ignores a capture that finishes after switching cities', async () => {
	const { promise, resolve } = Promise.withResolvers<{ published_at: string }>();
	mocks.fetchCaptureSnapshot.mockReturnValueOnce(promise);
	const dispose = dataPulse.subscribeCapture('stm');
	await vi.advanceTimersByTimeAsync(discoveryInterval);
	dispose();
	dataPulse.subscribeCapture('octranspo');
	resolve({ published_at: next });
	await vi.advanceTimersByTimeAsync(0);
	expect(dataPulse.lastSeenMs).toBeNull();
	await vi.advanceTimersByTimeAsync(discoveryInterval);
	expect(mocks.fetchCaptureSnapshot).toHaveBeenLastCalledWith('octranspo', expect.any(AbortSignal));
	expect(dataPulse.lastSeenMs).toBe(Date.parse(first));
	expect(mocks.bumpEpoch).not.toHaveBeenCalled();
});

it('recovers from an unavailable capture and stops when the last reader leaves', async () => {
	mocks.fetchCaptureSnapshot.mockRejectedValueOnce(new Error('offline'));
	const firstReader = dataPulse.subscribeCapture('stm');
	const lastReader = dataPulse.subscribeCapture('stm');
	firstReader();
	await vi.advanceTimersByTimeAsync(discoveryInterval * 2);
	expect(dataPulse.lastSeenMs).toBe(Date.parse(first));
	expect(mocks.fetchCaptureSnapshot).toHaveBeenCalledTimes(2);
	lastReader();
	await vi.advanceTimersByTimeAsync(discoveryInterval);
	expect(mocks.fetchCaptureSnapshot).toHaveBeenCalledTimes(2);
});
