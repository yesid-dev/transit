import { beforeEach, expect, it, vi } from 'vitest';

const getRecordAnswer = vi.hoisted(() => vi.fn());
vi.mock('#lib/server/engine.ts', () => ({ getRecordAnswer }));
import { load } from './+page.server';

const key = JSON.stringify(['A', 1, '07:42:00']);
function event(search: string, id = key) {
	const url = new URL(
		`https://transit1.yesid.dev/fr/departure/${encodeURIComponent(id)}?${search}`,
	);
	return {
		params: { key: id },
		url,
		request: new Request(url, { headers: { 'cf-connecting-ip': '192.0.2.24' } }),
		parent: async () => ({ providerId: 'demo', lang: 'fr', v1: null }),
	} as unknown as Parameters<typeof load>[0];
}

const archive = (present: boolean) => ({
	kind: 'answer',
	answer: {
		cells: present ? [{ key: { direction: 1, departure: '07:42:00' } }] : [],
		evidence: { days_included: ['2026-11-18'] },
	},
});

beforeEach(() => {
	getRecordAnswer
		.mockReset()
		.mockImplementation(({ parameters }) =>
			Promise.resolve(parameters.group === 'departure' ? archive(true) : { kind: 'unconfigured' }),
		);
});

it('starts all Record sections independently and limits the stop sequence to the chosen day', async () => {
	const result = await load(event('recordFrom=2026-11-16&recordTo=2026-11-19&day=2026-11-18'));
	expect(result).toMatchObject({ day: '2026-11-18', lang: 'fr', mode: 'record' });
	expect(result?.sections.map(({ section }: { section: string }) => section)).toEqual([
		'observed',
		'delay',
		'stops',
		'missed',
	]);
	expect(
		getRecordAnswer.mock.calls
			.slice(1)
			.map(([query, period]) => [query.parameters.group, period.from, period.to]),
	).toEqual([
		['day', '2026-11-16', '2026-11-19'],
		[undefined, '2026-11-16', '2026-11-19'],
		['stop', '2026-11-18', '2026-11-18'],
		['day', '2026-11-16', '2026-11-19'],
	]);
	expect(getRecordAnswer).toHaveBeenCalledWith(
		{
			path: '/measure',
			parameters: {
				group: 'stop',
				measure: 'punctuality',
				line: 'A',
				direction: '1',
				departure: '07:42:00',
			},
		},
		expect.objectContaining({ city: 'demo', visitorIp: '192.0.2.24' }),
	);
});

it('falls back to the last selected date and rejects malformed departure identities', async () => {
	const search = 'recordFrom=2026-11-16&recordTo=2026-11-19&day=2026-11-20';
	await expect(load(event(search))).resolves.toMatchObject({ day: '2026-11-19' });
	getRecordAnswer.mockClear();
	await expect(load(event(search, JSON.stringify(['A', 7, '07:42:00'])))).rejects.toMatchObject({
		status: 404,
	});
	expect(getRecordAnswer).not.toHaveBeenCalled();
});

it('keeps Live available without fetching the historical sections', async () => {
	await expect(load(event('frameMode=live'))).resolves.toMatchObject({
		mode: 'live',
		sections: [],
		liveTrips: null,
	});
	expect(getRecordAnswer).toHaveBeenCalledOnce();
	expect(getRecordAnswer.mock.calls[0][0].parameters.group).toBe('departure');
});

it('answers 404 for a departure absent from the archive and 503 for an unavailable identity', async () => {
	const search = 'recordFrom=2026-11-16&recordTo=2026-11-19';
	getRecordAnswer.mockResolvedValueOnce(archive(false));
	await expect(load(event(search))).rejects.toMatchObject({
		status: 404,
		body: { code: 'DEPARTURE_NOT_FOUND' },
	});
	getRecordAnswer.mockResolvedValueOnce({ kind: 'timeout' });
	await expect(load(event(search))).rejects.toMatchObject({ status: 503 });
});
