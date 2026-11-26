import { render } from '@testing-library/svelte';
import { afterEach, expect, it, vi } from 'vitest';
import LiveCaptureHarness from './LiveCaptureHarness.svelte';
import { livePause } from './livePause.ts';

afterEach(() => {
	livePause.reset();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

it('stops the 20 s refresh while live updates are paused and refreshes at once on resume', async () => {
	vi.useFakeTimers();
	const fetcher = vi.fn(async () => new Response(null, { status: 503 }));
	vi.stubGlobal('fetch', fetcher);
	render(LiveCaptureHarness, { capture: Promise.resolve(null) });
	await vi.advanceTimersByTimeAsync(20_000);
	expect(fetcher).toHaveBeenCalledTimes(1);

	livePause.set(true);
	await vi.advanceTimersByTimeAsync(120_000);
	expect(fetcher).toHaveBeenCalledTimes(1);

	livePause.set(false);
	await vi.advanceTimersByTimeAsync(0);
	expect(fetcher).toHaveBeenCalledTimes(2);
	await vi.advanceTimersByTimeAsync(20_000);
	expect(fetcher).toHaveBeenCalledTimes(3);
});
