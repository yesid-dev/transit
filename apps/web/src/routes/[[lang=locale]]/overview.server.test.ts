import { describe, expect, it, vi } from 'vitest';

const engine = vi.hoisted(() => ({
	getCityCatalog: vi.fn(async () => ({ providers: [{ id: 'fixture', timezone: 'UTC' }] })),
	getRecordCsv: vi.fn(),
	getMeasure: vi.fn(),
	getRanking: vi.fn(),
	getRecordAnswer: vi.fn(),
	getScheduleEdition: vi.fn(),
}));
vi.mock('#lib/server/engine.ts', () => engine);

import { GET } from './record.csv/+server';
import { load } from './+page.server';

const from = '2026-11-08';
const to = '2026-11-14';
const bytes = new Uint8Array([0xef, 0xbb, 0xbf, 0x61, 13, 10]);

describe('Overview exports', () => {
	it.each([
		['punctuality', '/measure', { measure: 'punctuality' }, from, to],
		['previous', '/measure', { measure: 'on_time' }, '2026-11-01', '2026-11-07'],
		['delivery', '/measure', { measure: 'trips_run' }, from, to],
		['trend', '/measure', { measure: 'on_time', group: 'day' }, from, to],
		['lines', '/ranking', { kind: 'line', measure: 'on_time', limit: '3' }, from, to],
		['stops', '/ranking', { kind: 'stop', measure: 'on_time', limit: '3' }, from, to],
	] as const)(
		'asks the engine for the %s CSV and preserves its bytes',
		async (section, path, parameters, start, end) => {
			engine.getRecordCsv.mockResolvedValueOnce(
				new Response(bytes, { headers: { 'content-type': 'text/csv' } }),
			);
			const url = new URL(
				`https://example.test/fr/record.csv?provider=fixture&recordFrom=${from}&recordTo=${to}&section=${section}`,
			);
			const response = await GET({
				url,
				request: new Request(url),
				params: { lang: 'fr' },
			} as Parameters<typeof GET>[0]);
			expect(engine.getRecordCsv).toHaveBeenLastCalledWith(
				{ path, parameters },
				{ from: start, to: end, city: 'fixture', visitorIp: null },
				'fr',
			);
			expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
		},
	);
});

it('returns the page shell before a client navigation has a schedule or engine answers', async () => {
	const waiting = new Promise(() => undefined);
	engine.getScheduleEdition.mockReturnValueOnce(waiting);
	engine.getMeasure.mockReturnValue(waiting);
	engine.getRanking.mockReturnValue(waiting);
	engine.getRecordAnswer.mockReturnValue(waiting);
	const url = new URL(
		`https://example.test/?provider=fixture&frameMode=record&recordFrom=${from}&recordTo=${to}`,
	);
	const result = await Promise.race([
		Promise.resolve(
			load({
				url,
				request: new Request(url),
				locals: {},
				parent: async () => ({
					providerId: 'fixture',
					provider: {
						id: 'fixture',
						timezone: 'UTC',
						labels: { en: { city: 'Example', operator: 'Example' } },
						inputs: {},
					},
					lang: 'en',
					schedule: null,
				}),
			} as Parameters<typeof load>[0]),
		),
		new Promise<null>((resolve) => setTimeout(() => resolve(null), 0)),
	]);
	expect(result?.record?.punctuality).toBe(waiting);
	expect(result?.record?.totals).toBeInstanceOf(Promise);
});
