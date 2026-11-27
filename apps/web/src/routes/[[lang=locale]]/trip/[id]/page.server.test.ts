import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { load } from './+page.server';

const query = vi.hoisted(() => vi.fn());
vi.mock('#lib/server/engine.ts', () => ({ query }));

const now = '2026-11-27T15:00:00Z';
const trip = { trip_id: '123', route_id: '24', start_time: '10:00:00', direction_id: 0 };

function loadTrip() {
	const url = new URL('https://transit.yesid.dev/trip/123');
	return load({
		params: { id: '123' },
		parent: async () => ({
			providerId: 'stm',
			lang: 'en',
			provider: { inputs: { trip_updates: true, vehicle_positions: false } },
		}),
		url,
		request: new Request(url),
		setHeaders: vi.fn(),
	} as unknown as Parameters<typeof load>[0]);
}

beforeEach(() => {
	query.mockReset();
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(new Date(now));
});
afterEach(() => vi.useRealTimers());

it.each([
	['stale empty', '2026-11-27T14:55:00Z', [], 503],
	['stale match', '2026-11-27T14:55:00Z', [trip], 503],
	['current empty', now, [], 404],
	['current cancellation', now, [{ ...trip, relationship: 3 }], 404],
	['current match', now, [trip], 307],
])(
	'serves the correct status for %s observations',
	async (_, captured_at, trip_updates, status) => {
		query.mockResolvedValueOnce({
			kind: 'answer',
			answer: {
				city: 'stm',
				trip_updates,
				feed: { family: 'trip_updates', captured_at, fresh_for_seconds: 60, source_lag_seconds: 0 },
			},
		});
		await expect(loadTrip()).rejects.toMatchObject({ status });
	},
);
