import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { measure, period, ranking, stateText } from '#lib/features/home/overviewRecord.fixture.ts';
import { getMeasure, getRanking, type MeasureAnswer } from './engine.ts';

const { env } = vi.hoisted(() => ({ env: { ENGINE_ORIGIN: undefined as string | undefined } }));
vi.mock('cloudflare:workers', () => ({ env }));

const dates = { ...period, city: 'stm' };
const fetcher = vi.fn<typeof fetch>();

beforeEach(() => {
	env.ENGINE_ORIGIN = 'https://engine.test';
	fetcher.mockReset();
	vi.stubGlobal('fetch', fetcher);
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('overview engine requests', () => {
	it('makes no requests when the Worker origin is unset', async () => {
		env.ENGINE_ORIGIN = undefined;
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
			expect(String(fetcher.mock.calls[0]?.[0])).toBe(
				'https://engine.test/measure?city=stm&from=2026-11-08&to=2026-11-14&measure=on_time',
			);
		},
	);

	it('asks for three worst rows and leaves the class up to the engine', async () => {
		fetcher.mockResolvedValue(Response.json(ranking));
		expect(await getRanking('line', dates)).toEqual({ kind: 'answer', answer: ranking });
		expect(String(fetcher.mock.calls[0]?.[0])).toBe(
			'https://engine.test/ranking?city=stm&from=2026-11-08&to=2026-11-14&kind=line&measure=on_time&limit=3',
		);
	});

	it('returns unavailable when the response is invalid', async () => {
		fetcher.mockResolvedValue(Response.json({ state: 'measured', value: 0 }));
		expect(await getMeasure('on_time', dates)).toEqual({ kind: 'unreachable' });
	});

	it('keeps requests at the configured origin when the engine redirects', async () => {
		fetcher.mockResolvedValue(Response.redirect('https://another-origin.test'));
		expect(await getMeasure('on_time', dates)).toEqual({ kind: 'unreachable' });
		expect(fetcher).toHaveBeenCalledExactlyOnceWith(expect.any(URL), {
			redirect: 'manual',
			signal: expect.any(AbortSignal),
		});
	});

	it('aborts a timed out request and returns a typed gap', async () => {
		const controller = new AbortController();
		vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
		fetcher.mockImplementation(async (_url, options) => {
			const signal = options!.signal!;
			return new Promise<Response>((_resolve, reject) => {
				signal.addEventListener('abort', () => reject(signal.reason), { once: true });
			});
		});
		const result = getMeasure('on_time', dates);
		controller.abort(new DOMException('Timed out', 'TimeoutError'));
		expect(await result).toEqual({ kind: 'timeout' });
	});
});
