import { expect, it, vi } from 'vitest';
import { loadAlertRecord } from '#lib/server/alertRecord.ts';
import { load } from './+page.server.ts';

vi.mock('#lib/server/alertRecord.ts', () => ({ loadAlertRecord: vi.fn(() => []) }));

const provider = {
	id: 'stm',
	timezone: 'America/Toronto',
	inputs: { i3_alerts: true, service_alerts: false },
	labels: { en: { operator: 'STM', city: 'Montréal' } },
	alert_links: {},
};

it.each(['record', 'live'] as const)('uses only the expected Alerts reader in %s', async (mode) => {
	const url = new URL(
		`https://transit.example/alerts?provider=stm&frameMode=${mode}&recordFrom=2026-11-17&recordTo=2026-11-23`,
	);
	const fetcher = vi.fn(async (_path: string) =>
		Response.json({
			version: 2,
			city: 'stm',
			published_at: '2026-11-23T16:00:00Z',
			stable_vehicle_ids: true,
			feeds: {},
			vehicle_positions: null,
			alerts: [],
		}),
	);
	vi.mocked(loadAlertRecord).mockClear();
	const result = await load({
		url,
		request: new Request(url),
		fetch: fetcher,
		parent: async () => ({ providerId: provider.id, provider, lang: 'en' }),
	} as unknown as Parameters<typeof load>[0]);

	if (mode === 'live') {
		await expect(result?.alertRecord.capture).resolves.toMatchObject({ city: 'stm', alerts: [] });
		expect(fetcher.mock.calls.map(([path]) => path)).toEqual(['/api/live?city=stm']);
		expect(loadAlertRecord).not.toHaveBeenCalled();
	} else {
		expect(result?.alertRecord.capture).toBeNull();
		expect(fetcher).not.toHaveBeenCalled();
		expect(loadAlertRecord).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({ city: 'stm' }),
		);
	}
});
