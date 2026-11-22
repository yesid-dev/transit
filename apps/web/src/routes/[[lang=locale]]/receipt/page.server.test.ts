import { expect, it, vi } from 'vitest';

const getRecordAnswer = vi.hoisted(() => vi.fn().mockResolvedValue({ kind: 'unconfigured' }));
vi.mock('#lib/server/engine.ts', () => ({ getRecordAnswer }));
import { load } from './+page.server';

function event(href: string) {
	const url = new URL(href);
	return {
		url,
		request: new Request(url),
		parent: async () => ({
			providerId: 'demo',
			lang: 'fr',
			provider: { labels: { fr: { city: 'Montréal' } } },
		}),
	} as unknown as Parameters<typeof load>[0];
}

it('streams the selected period, including both rankings and the agency messages', async () => {
	const result = await load(
		event('https://transit1.yesid.dev/fr/receipt?recordFrom=2026-11-18&recordTo=2026-11-18'),
	);
	expect(result?.report?.cityName).toBe('Montréal');
	expect(result?.report?.sections.map(({ section }: { section: string }) => section)).toEqual([
		'punctuality',
		'delivery',
		'periods',
		'lines',
		'stops',
		'messages',
	]);
	const period = expect.objectContaining({ city: 'demo', from: '2026-11-18', to: '2026-11-18' });
	expect(getRecordAnswer).toHaveBeenCalledWith(
		{
			path: '/ranking',
			parameters: { measure: 'on_time', kind: 'line', class: 'all', limit: '3' },
		},
		period,
	);
	expect(getRecordAnswer).toHaveBeenCalledWith(
		{
			path: '/measure',
			parameters: { measure: 'alert_counts', alert_details: '1' },
		},
		period,
	);
});

it('keeps explicit historical receipt URLs on the archive', async () => {
	getRecordAnswer.mockClear();
	await expect(load(event('https://transit1.yesid.dev/receipt?date=2026-08-30'))).resolves.toEqual({
		report: null,
	});
	expect(getRecordAnswer).not.toHaveBeenCalled();
});
