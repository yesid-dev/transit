import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { measure, period, ranking, stateText } from '#lib/features/home/overviewRecord.fixture.ts';
import {
	getMeasure,
	getRanking,
	getRecordAnswer,
	getRecordCsv,
	type MeasureAnswer,
} from './engine.ts';

const { env } = vi.hoisted(() => ({
	env: { QUESTION_PROXY: undefined as { fetch(request: Request): Promise<Response> } | undefined },
}));
vi.mock('cloudflare:workers', () => ({ env }));

const dates = { ...period, city: 'stm' };
const fetcher = vi.fn<(request: Request) => Promise<Response>>();

beforeEach(() => {
	env.QUESTION_PROXY = { fetch: fetcher };
	fetcher.mockReset();
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe('overview engine requests', () => {
	it('makes no requests when the binding is absent', async () => {
		env.QUESTION_PROXY = undefined;
		expect(await getMeasure('on_time', dates)).toEqual({ kind: 'unconfigured' });
		expect(await getRanking('stop', dates)).toEqual({ kind: 'unconfigured' });
		expect(fetcher).not.toHaveBeenCalled();
	});

	it.each(Object.keys(stateText) as MeasureAnswer['state'][])(
		'keeps the %s state and its evidence',
		async (state) => {
			const answer = measure(state);
			fetcher.mockResolvedValue(Response.json(answer));
			expect(await getMeasure('on_time', dates)).toEqual({ kind: 'answer', answer });
			expect(fetcher.mock.calls[0]?.[0].url).toBe(
				'https://data.yesid.dev/v2/stm/measure?from=2026-11-08&to=2026-11-14&measure=on_time',
			);
		},
	);

	it('asks for three worst rows and leaves the class up to the engine', async () => {
		fetcher.mockResolvedValue(Response.json(ranking));
		expect(await getRanking('line', dates)).toEqual({ kind: 'answer', answer: ranking });
		expect(fetcher.mock.calls[0]?.[0].url).toBe(
			'https://data.yesid.dev/v2/stm/ranking?from=2026-11-08&to=2026-11-14&kind=line&measure=on_time&limit=3',
		);
	});

	it('returns unavailable when the response is invalid', async () => {
		fetcher.mockResolvedValue(Response.json({ state: 'measured', value: 0 }));
		expect(await getMeasure('on_time', dates)).toEqual({ kind: 'unreachable' });
	});

	it('keeps requests at the configured origin when the engine redirects', async () => {
		fetcher.mockResolvedValue(Response.redirect('https://another-origin.test'));
		expect(await getMeasure('on_time', dates)).toEqual({ kind: 'unreachable' });
		expect(fetcher).toHaveBeenCalledTimes(1);
		expect(fetcher.mock.calls[0]?.[0].redirect).toBe('manual');
	});

	it('aborts a timed out request and returns a typed gap', async () => {
		const controller = new AbortController();
		vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
		fetcher.mockImplementation(async ({ signal }) => {
			return new Promise<Response>((_resolve, reject) => {
				signal.addEventListener('abort', () => reject(signal.reason), { once: true });
			});
		});
		const result = getMeasure('on_time', dates);
		controller.abort(new DOMException('Timed out', 'TimeoutError'));
		expect(await result).toEqual({ kind: 'timeout' });
	});

	it('marks a last-good answer and distinguishes proxy backpressure', async () => {
		const answer = measure();
		fetcher.mockResolvedValueOnce(
			Response.json(answer, {
				headers: { 'x-transit-answer': 'last-good' },
			}),
		);
		expect(await getMeasure('on_time', dates)).toEqual({ kind: 'answer', answer, lastGood: true });
		fetcher.mockResolvedValueOnce(
			new Response(null, {
				status: 503,
				headers: { 'retry-after': '30' },
			}),
		);
		expect(await getMeasure('on_time', dates)).toEqual({ kind: 'busy' });
		fetcher.mockResolvedValueOnce(new Response(null, { status: 503 }));
		expect(await getMeasure('on_time', dates)).toEqual({ kind: 'unreachable' });
	});

	it('accepts compact method metadata and preserves explanatory text when supplied', async () => {
		const text = {
			en: { counts: 'Count each alert once.', limits: 'Some dates may be missing.' },
			fr: { counts: 'Compter chaque alerte une fois.', limits: 'Certaines dates peuvent manquer.' },
		};
		fetcher.mockResolvedValueOnce(
			Response.json({ ...measure(), info: [{ minimum_sample: 30 }, { text }] }),
		);
		const result = await getRecordAnswer(
			{ path: '/measure', parameters: { measure: 'on_time' } },
			dates,
		);
		expect(result).toMatchObject({ kind: 'answer', answer: { info: [{}, { text }] } });
	});

	it('maps stop groups and localized CSV, forwarding only the visitor IP to the binding', async () => {
		const query = {
			path: '/measure' as const,
			parameters: { measure: 'on_time', stop: 'S 1', group: 'line' },
		};
		const scope = { ...dates, city: 'other-city', visitorIp: '192.0.2.24' };
		const result = { cells: [], evidence: measure().evidence, coverage_note: null };
		fetcher.mockResolvedValueOnce(Response.json(result));
		expect(await getRecordAnswer(query, scope)).toMatchObject({
			kind: 'answer',
			answer: { cells: [], evidence: { start_date: dates.from } },
		});
		expect(fetcher.mock.calls[0]?.[0].headers.get('x-transit-visitor-ip')).toBe('192.0.2.24');
		fetcher.mockResolvedValueOnce(
			new Response('Mesure,Valeur', {
				headers: { 'content-type': 'text/csv', 'x-transit-answer': 'last-good' },
			}),
		);
		const response = await getRecordCsv(query, scope, 'fr');
		expect(response?.headers.get('x-transit-answer')).toBe('last-good');
		expect(await response?.text()).toBe('Mesure,Valeur');
		expect(fetcher.mock.calls[1]?.[0].url).toBe(
			'https://data.yesid.dev/v2/other-city/measure?from=2026-11-08&to=2026-11-14&measure=on_time&stop=S+1&group=line&format=csv&lang=fr',
		);
	});
});
