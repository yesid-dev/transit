import { describe, expect, it, vi } from 'vitest';
import { createServer } from 'vite';

describe('createHistoryRangeResource SSR', () => {
	it('exposes only accepted seed values before client effects run', async () => {
		const server = await createServer({
			configFile: 'vite.config.ts',
			appType: 'custom',
			logLevel: 'silent',
			optimizeDeps: { noDiscovery: true },
			server: { middlewareMode: true },
		});
		try {
			const resources = (await server.ssrLoadModule(
				'/src/lib/v1/history/rangeResource.svelte.ts',
			)) as typeof import('./rangeResource.svelte');
			const loader = {
				loadIndex: vi.fn(async () => ({ id: 'accepted' })),
				availability: () => ({
					kind: 'continuous' as const,
					firstDate: '2026-01-01',
					lastDate: '2026-01-31',
					gaps: [],
				}),
				defaultWindow: () => ({ from: '2026-01-01', to: '2026-01-31' }),
				load: vi.fn(async () => ({ value: { count: 10 }, status: 'complete' as const })),
			};
			const request = resources.historyRangeRequestFromSearchParams(
				new URLSearchParams('from=2026-01-10&to=2026-01-20'),
			);
			const seed = await resources.loadHistoryRangeSeed(
				loader,
				request,
				new AbortController().signal,
			);
			const history = resources.createHistoryRangeResource(loader, {
				initialRequest: request,
				seed: () => seed,
			});
			expect(history.state).toBe('ready');
			expect(history.value).toEqual({ count: 10 });
			expect(history.resolved?.selection).toEqual({ from: '2026-01-10', to: '2026-01-20' });
			expect(loader.loadIndex).toHaveBeenCalledTimes(1);
			expect(loader.load).toHaveBeenCalledTimes(1);
			history.destroy();

			for (const [kind, from] of [
				['malformed', 'bad'],
				['outside', '2025-01-01'],
				['gap', '2026-01-15'],
				['missing-index', '2026-01-10'],
			] as const) {
				const fallbackLoader = {
					...loader,
					load: vi.fn(async () => ({ value: null, status: 'no_data' as const })),
					loadIndex: async () => (kind === 'missing-index' ? null : { id: 'accepted' }),
					availability: () => ({
						...loader.availability(),
						gaps: [{ start_date: '2026-01-15', end_date: '2026-01-15', reason: 'outage' }],
					}),
				};
				const fallbackRequest = resources.historyRangeRequestFromSearchParams(
					new URLSearchParams({ from, to: '2026-01-20' }),
				);
				const fallbackSeed = await resources.loadHistoryRangeSeed(
					fallbackLoader,
					fallbackRequest,
					new AbortController().signal,
				);
				const fallbackHistory = resources.createHistoryRangeResource(fallbackLoader, {
					initialRequest: fallbackRequest,
					seed: () => fallbackSeed,
				});
				try {
					expect(fallbackHistory.state, kind).toBe('current');
					expect(fallbackHistory.value, kind).toBeNull();
					expect(fallbackLoader.load, kind).not.toHaveBeenCalled();
				} finally {
					fallbackHistory.destroy();
				}
			}
		} finally {
			await server.close();
		}
	}, 30000);
});
