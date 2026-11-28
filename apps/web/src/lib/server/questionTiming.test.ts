import { afterEach, expect, it, vi } from 'vitest';
import { getRequestEvent } from '$app/server';
import { documentServerTiming, readProxyTiming, timeQuestion } from './questionTiming.ts';

function servePage() {
	const page = { request: new Request('https://transit.test/lines/51') };
	vi.mocked(getRequestEvent).mockReturnValue(page as ReturnType<typeof getRequestEvent>);
	return page;
}

afterEach(() => {
	vi.mocked(getRequestEvent).mockReset();
	vi.mocked(getRequestEvent).mockImplementation(() => {
		throw new Error('No page is being served');
	});
});

it('reads the source, cache state and engine timing the proxy reports', () => {
	expect(
		readProxyTiming(
			'src;desc=engine, cache;desc=miss, upstream;dur=4900.12, queue;dur=71.45, engine;dur=4849.72',
		),
	).toEqual({ source: 'engine', cache: 'miss', queueMs: 71.45, engineMs: 4849.72 });
	expect(readProxyTiming('src;desc=kv, cache;desc=hit')).toEqual({ source: 'kv', cache: 'hit' });
	expect(readProxyTiming('src;desc="Bad Source", engine;dur=soon, queue')).toEqual({});
	expect(readProxyTiming(null)).toEqual({});
});

it('sums the questions a page answered before its headers and counts the waiting ones', () => {
	const page = servePage();
	const cached = timeQuestion('punctuality');
	const engine = timeQuestion('waiting_and_gaps');
	timeQuestion('crowding');
	cached(new Headers({ 'server-timing': 'src;desc=kv, cache;desc=hit' }));
	engine(
		new Headers({
			'server-timing': 'src;desc=engine, cache;desc=miss, queue;dur=12.5, engine;dur=4800',
		}),
	);
	// A question settles once; a second call changes nothing.
	engine(new Headers({ 'server-timing': 'engine;dur=1' }));

	const timing = documentServerTiming(page)!;
	expect(timing).toMatch(/^questions;desc="answered 2 \(cache 1, engine 1\), waiting 1", /);
	expect(timing).toContain('engine;dur=4800.0');
	expect(timing).toContain('queue;dur=12.5');
	expect(timing).toMatch(/slowest;desc="(?:punctuality|waiting_and_gaps)";dur=\d+\.\d$/);
});

it('times nothing outside a page request', () => {
	timeQuestion('punctuality')(new Headers({ 'server-timing': 'engine;dur=5' }));
	expect(documentServerTiming({})).toBeNull();
});

it('names an unusual question plainly', () => {
	const page = servePage();
	timeQuestion('Measure <script>')(null);
	expect(documentServerTiming(page)).toContain('slowest;desc="question"');
});
