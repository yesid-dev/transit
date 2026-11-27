import { beforeEach, expect, it, vi } from 'vitest';

const { getRecordAnswer, getRecordCsv } = vi.hoisted(() => ({
	getRecordAnswer: vi.fn().mockResolvedValue({ kind: 'unconfigured' }),
	getRecordCsv: vi.fn(),
}));
vi.mock('#lib/server/engine.ts', () => ({
	getRecordAnswer,
	getRecordCsv,
	getScheduleEdition: vi.fn(),
}));
import { load } from './+page.server';
import { GET as getCsv } from './record.csv/+server';

beforeEach(() => vi.clearAllMocks());

function event(href: string, recordThrough?: string) {
	const url = new URL(href);
	return {
		url,
		request: new Request(url),
		parent: async () => ({
			providerId: 'demo',
			lang: 'fr',
			provider: { record_through: recordThrough, inputs: {}, labels: { fr: { city: 'Montréal' } } },
		}),
	} as unknown as Parameters<typeof load>[0];
}

it('streams both rankings and agency messages for seven inclusive dates', async () => {
	const result = await load(
		event('https://transit1.yesid.dev/fr/receipt?recordFrom=2026-11-12&recordTo=2026-11-18'),
	);
	expect(result?.report?.cityName).toBe('Montréal');
	expect(result?.report?.messagesLimited).toBe(false);
	expect(result?.report?.sections.map(({ section }: { section: string }) => section)).toEqual([
		'punctuality',
		'delivery',
		'periods',
		'lines',
		'stops',
		'messages',
	]);
	const period = expect.objectContaining({ city: 'demo', from: '2026-11-12', to: '2026-11-18' });
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

it('streams the alert total over eight dates without requesting message details', async () => {
	const result = await load(
		event('https://transit1.yesid.dev/fr/receipt?recordFrom=2026-11-11&recordTo=2026-11-18'),
	);
	expect(result?.report?.messagesLimited).toBe(true);
	expect(result?.report?.sections.map(({ section }: { section: string }) => section)).toEqual([
		'punctuality',
		'delivery',
		'periods',
		'lines',
		'stops',
		'messages',
	]);
	expect(getRecordAnswer).toHaveBeenCalledWith(
		{ path: '/measure', parameters: { measure: 'alert_counts' } },
		expect.objectContaining({ from: '2026-11-11', to: '2026-11-18' }),
	);
	expect(getRecordAnswer).not.toHaveBeenCalledWith(
		expect.objectContaining({ parameters: expect.objectContaining({ alert_details: '1' }) }),
		expect.anything(),
	);
});

it('streams the five newest agency messages by first start, natural line order, and displayed text', async () => {
	const message = (id: string, line: string, text: string, ...days: number[]) => ({
		source: 'feed',
		id,
		version: '1',
		routes: [line],
		stops: [],
		header: { en: 'Your line', fr: 'Votre ligne' },
		description: { en: null, fr: text },
		periods: days.map((day) => ({
			start: `2026-11-${day}T12:00:00Z`,
			end: `2026-11-${day}T19:00:00Z`,
		})),
	});
	const messages = [
		message('1', '2', 'Ancien avis.', 18, 12),
		message('2', '10', 'Travaux.', 17),
		message('3', '2', 'Travaux.', 17),
		message('4', '2', 'Détour.', 17),
		message('5', '99', 'Détour.', 16),
		message('6', '8', 'Arrêt déplacé.', 18),
		message('7', '1', 'Date inconnue.'),
	];
	await getRecordAnswer.withImplementation(
		async ({ parameters }) =>
			parameters.alert_details
				? { kind: 'answer', answer: { value: {}, evidence: { alert_messages: messages } } }
				: { kind: 'unconfigured' },
		async () => {
			const result = await load(
				event('https://transit1.yesid.dev/fr/receipt?recordFrom=2026-11-12&recordTo=2026-11-18'),
			);
			const streamed = await result?.report?.sections.find(
				({ section }: { section: string }) => section === 'messages',
			)?.answer;
			if (streamed?.kind !== 'answer' || !('value' in streamed.answer))
				throw new Error('Expected an agency message answer');
			expect(streamed.answer.evidence.alert_messages?.map(({ id }: { id: string }) => id)).toEqual([
				'6',
				'4',
				'3',
				'2',
				'5',
			]);
			// Seven alerts, six notices: "Travaux." on lines 10 and 2 the same day is one notice.
			expect(streamed.answer.evidence.notice_total).toBe(6);
		},
	);
});

it('pins the default to the last complete day', async () => {
	await expect(
		load(event('https://transit1.yesid.dev/fr/receipt', '2026-11-23')),
	).rejects.toMatchObject({
		status: 307,
		location: '/fr/receipt?frameMode=record&recordFrom=2026-11-23&recordTo=2026-11-23',
	});
	expect(getRecordAnswer).not.toHaveBeenCalled();
});

it('opens the last built day when Yesterday has not been added', async () => {
	await expect(
		load(
			event(
				'https://transit1.yesid.dev/fr/receipt?period=yesterday&recordFrom=2026-11-24&recordTo=2026-11-24',
				'2026-11-23',
			),
		),
	).resolves.toMatchObject({
		seoTitle: 'Rapport du lundi 23 novembre 2026',
		report: { period: { from: '2026-11-23', to: '2026-11-23' } },
	});
	expect(getRecordAnswer).toHaveBeenCalledWith(
		expect.anything(),
		expect.objectContaining({ from: '2026-11-23', to: '2026-11-23' }),
	);
});

it('rejects an eight-date agency message CSV request before asking the engine', () => {
	const url = new URL(
		'https://transit1.yesid.dev/fr/receipt/record.csv?provider=demo&section=messages&recordFrom=2026-11-11&recordTo=2026-11-18',
	);
	const request = new Request(url);
	expect(() =>
		getCsv({ params: { lang: 'fr' }, url, request } as Parameters<typeof getCsv>[0]),
	).toThrow(expect.objectContaining({ status: 400 }));
	expect(getRecordCsv).not.toHaveBeenCalled();
});

it('shows an unavailable period for dates before the clean record', async () => {
	await expect(
		load(event('https://transit1.yesid.dev/receipt?date=2026-08-30')),
	).resolves.toMatchObject({
		report: { period: null, sections: [] },
	});
	expect(getRecordAnswer).not.toHaveBeenCalled();
});
