import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { measure, period, ranking, stateText } from '#lib/features/home/overviewRecord.fixture.ts';
import {
	getCaptureResponse,
	getDelayDistribution,
	getFinderSeries,
	getMeasure,
	getRanking,
	getRecordAnswer,
	getRecordCsv,
	type MeasureAnswer,
} from './engine.ts';
import { finderQuestions } from './engineQuestion.ts';

const { env } = vi.hoisted(() => ({
	env: {
		QUESTION_PROXY: undefined as { fetch(request: Request): Promise<Response> } | undefined,
		QUESTION_FIXTURE_ORIGIN: undefined as string | undefined,
	},
}));
vi.mock('cloudflare:workers', () => ({ env }));

const dates = { ...period, city: 'stm' };
const fetcher = vi.fn<(request: Request) => Promise<Response>>();

beforeEach(() => {
	env.QUESTION_PROXY = { fetch: fetcher };
	env.QUESTION_FIXTURE_ORIGIN = undefined;
	fetcher.mockReset();
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

it('Vite development reads from the public v2 proxy when a local service binding is present', async () => {
	vi.stubEnv('MODE', 'development');
	const direct = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null));
	await getCaptureResponse('stm', new AbortController().signal);
	expect(fetcher).not.toHaveBeenCalled();
	const request = direct.mock.calls[0]?.[0] as Request;
	expect(request.url).toBe('https://data.yesid.dev/v2/stm/live');
});

it('reads the distribution as a series and treats deploy skew as unavailable', async () => {
	const timing = measure();
	const answer = {
		measure: 'delay_distribution',
		group: 'delay_minute',
		state: timing.state,
		state_text: timing.state_text,
		coverage_note: timing.coverage_note,
		evidence: timing.evidence,
		cells: [
			{
				key: { min_seconds: null, max_seconds: -301, band: 'early' },
				value: { delay_distribution: 0.1, stop_events: 50 },
				state: timing.state,
				state_text: timing.state_text,
				evidence: { counts: { stop_events: 50 }, days_included: timing.evidence.days_included },
			},
		],
	};
	fetcher.mockResolvedValueOnce(Response.json(answer));
	expect(await getDelayDistribution(dates, { stop: 'S1' })).toMatchObject({
		kind: 'answer',
		answer,
	});
	const url = new URL(fetcher.mock.calls[0]![0].url);
	expect(url.searchParams.get('measure')).toBe('delay_distribution');
	expect(url.searchParams.get('stop')).toBe('S1');
	expect(url.searchParams.has('group')).toBe(false);
	fetcher.mockResolvedValueOnce(
		Response.json(
			{ reason: 'delay_distribution_unsupported', message: 'engine unavailable' },
			{ status: 409 },
		),
	);
	expect(await getDelayDistribution(dates)).toEqual({ kind: 'unreachable' });
});

it('keeps a timed-out Stops reading pending and returns the next answer as soon as it arrives', async () => {
	const first = new AbortController();
	const second = new AbortController();
	vi.spyOn(AbortSignal, 'timeout')
		.mockReturnValueOnce(first.signal)
		.mockReturnValueOnce(second.signal);
	const retry = Promise.withResolvers<Response>();
	fetcher
		.mockImplementationOnce(
			async ({ signal }) =>
				new Promise<Response>((_resolve, reject) => {
					signal.addEventListener('abort', () => reject(signal.reason), { once: true });
				}),
		)
		.mockReturnValueOnce(retry.promise);
	const read = getFinderSeries(finderQuestions.stops.punctuality, dates);
	const settled = vi.fn();
	void read.then(settled);
	first.abort(new DOMException('Timed out', 'TimeoutError'));
	await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
	expect(settled).not.toHaveBeenCalled();
	expect(fetcher.mock.calls[1][0].url).toBe(fetcher.mock.calls[0][0].url);
	const answer = { cells: [], evidence: measure().evidence, coverage_note: null };
	retry.resolve(Response.json(answer));
	expect(await read).toMatchObject({
		kind: 'answer',
		answer: { cells: [], evidence: { days_included: answer.evidence.days_included } },
	});
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

	it('asks for the three worst lines of every class, the list Rankings opens on', async () => {
		fetcher.mockResolvedValue(Response.json(ranking));
		expect(await getRanking('line', dates)).toEqual({ kind: 'answer', answer: ranking });
		expect(fetcher.mock.calls[0]?.[0].url).toBe(
			'https://data.yesid.dev/v2/stm/ranking?from=2026-11-08&to=2026-11-14&kind=line&measure=on_time&class=all&limit=3',
		);
		fetcher.mockClear();
		await getRanking('stop', dates);
		expect(fetcher.mock.calls[0]?.[0].url).toBe(
			'https://data.yesid.dev/v2/stm/ranking?from=2026-11-08&to=2026-11-14&kind=stop&measure=on_time&limit=3',
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

it('preserves the proxy request and leaves the loopback transport unadorned', async () => {
	const scope = { ...dates, visitorIp: '192.0.2.24' };
	const question = { path: '/measure', parameters: { measure: 'alert_counts' } } as const;
	const fixture = vi
		.spyOn(globalThis, 'fetch')
		.mockResolvedValue(new Response(null, { status: 503 }));
	env.QUESTION_FIXTURE_ORIGIN = 'http://127.0.0.1:4318';
	env.QUESTION_PROXY = undefined;
	await getRecordAnswer(question, scope);
	const local = fixture.mock.calls[0]?.[0] as Request;
	expect(new URL(local.url).origin).toBe(env.QUESTION_FIXTURE_ORIGIN);
	expect([...local.headers]).toEqual([]);

	env.QUESTION_PROXY = { fetch: fetcher };
	await getRecordAnswer(question, scope);
	const proxied = fetcher.mock.calls[0]?.[0];
	expect([...proxied.headers]).toEqual([['x-transit-visitor-ip', '192.0.2.24']]);
	expect(proxied.url).toBe(
		local.url.replace(env.QUESTION_FIXTURE_ORIGIN, 'https://data.yesid.dev'),
	);
	expect(proxied.redirect).toBe('manual');
});
