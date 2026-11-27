import { afterEach, expect, it, vi } from 'vitest';
import { READY_WAIT_MS, readyAnswers, streamed } from './readyAnswers.ts';

afterEach(() => vi.useRealTimers());

it('draws the answers that are ready and streams the rest', async () => {
	vi.useFakeTimers();
	const slow = new Promise<string>(() => {});
	const data = {
		view: 'record' as const,
		record: {
			sections: [
				{ section: 'punctuality', answer: Promise.resolve({ kind: 'answer', value: 1 }) },
				{ section: 'waiting', answer: slow },
			],
			network: Promise.resolve(null),
		},
	};
	const ready = readyAnswers(data);
	await vi.advanceTimersByTimeAsync(READY_WAIT_MS);
	const result = await ready;
	expect(result.view).toBe('record');
	expect(result.record.sections[0].answer).toEqual({ kind: 'answer', value: 1 });
	expect(result.record.sections[1].answer).toBe(slow);
	expect(result.record.network).toBeNull();
});

it('returns as soon as every answer is ready', async () => {
	vi.useFakeTimers();
	const ready = readyAnswers({ a: Promise.resolve(1), b: [Promise.resolve(2)] });
	await vi.advanceTimersByTimeAsync(0);
	await expect(ready).resolves.toEqual({ a: 1, b: [2] });
});

it('never waits longer than its limit', async () => {
	vi.useFakeTimers();
	const late = new Promise<number>((resolve) => setTimeout(() => resolve(1), READY_WAIT_MS + 50));
	let done = false;
	const ready = readyAnswers({ late }).then((result) => {
		done = true;
		return result;
	});
	await vi.advanceTimersByTimeAsync(READY_WAIT_MS - 1);
	expect(done).toBe(false);
	await vi.advanceTimersByTimeAsync(1);
	expect((await ready).late).toBe(late);
});

it('keeps a failed answer as a promise, so the page handles it as before', async () => {
	const failed = Promise.reject(new Error('engine'));
	const result = await readyAnswers({ failed }, 10);
	expect(result.failed).toBe(failed);
	await expect(result.failed).rejects.toThrow('engine');
});

it('keeps a busy or cut reading as a promise, so the page asks it again', async () => {
	const busy = Promise.resolve({ kind: 'busy' });
	const cut = Promise.resolve({ kind: 'timeout' });
	const result = await readyAnswers({ busy, cut, answer: Promise.resolve({ kind: 'answer' }) });
	expect(result.busy).toBe(busy);
	expect(result.cut).toBe(cut);
	expect(result.answer).toEqual({ kind: 'answer' });
});

it('keeps live readings streamed, so the server page never depends on the live feed', async () => {
	const capture = streamed(Promise.resolve({ city: 'stm' }));
	const result = await readyAnswers({ capture, trips: Promise.resolve(2) });
	expect(result.capture).toBe(capture);
	expect(result.trips).toBe(2);
});

it('leaves data without promises, and objects that are not plain, untouched', async () => {
	const when = new Date('2026-11-27T00:00:00Z');
	const data = { when, list: [1, 2], name: 'x' };
	expect(await readyAnswers(data)).toBe(data);
	const mixed = await readyAnswers({ when, answer: Promise.resolve(3) });
	expect(mixed.when).toBe(when);
	expect(mixed.answer).toBe(3);
});
