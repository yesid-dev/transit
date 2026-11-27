import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ScheduleEdition } from '#lib/search/searchIndex.ts';

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('./engine.ts', () => ({ query }));

let readTimetable: typeof import('./timetable.ts').readTimetable;
const edition: ScheduleEdition = { date: '2026-11-22', routes: [], stops: [] };
const catalog = {
	default_provider: 'demo',
	cleaning_version: 6,
	answer_revision: '0123456789abcdef',
	providers: [{ id: 'demo', record_through: '2026-11-22' }],
};
const answer = <T>(value: T) => ({ kind: 'answer', answer: value });
const options = {
	url: new URL('https://transit.test/lines?provider=demo'),
	visitorIp: null,
	needsSchedule: true,
};

beforeEach(async () => {
	vi.resetModules();
	query.mockReset();
	({ readTimetable } = await import('./timetable.ts'));
	vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

it('starts the catalogue and timetable together and applies a single cold boot budget', async () => {
	const pending = new Promise(() => {});
	query.mockReturnValue(pending);
	const boot = readTimetable(options);
	expect(query.mock.calls.map(([question]) => question.path)).toEqual([
		'/cities',
		'/demo/schedule-index',
	]);
	const firstDraw = boot
		.loadCatalog()
		.catch(() => null)
		.then(() => boot.loadEdition('demo'));
	await vi.advanceTimersByTimeAsync(1500);
	await expect(firstDraw).resolves.toBeNull();
});

it('keeps the checked timetable through ordinary requests and during a revision refresh', async () => {
	const newEdition = { ...edition, date: '2026-11-23' };
	const refresh = Promise.withResolvers<unknown>();
	let published = catalog;
	let schedule = Promise.resolve<unknown>(answer({ schedule: edition }));
	query.mockImplementation(({ path }) =>
		path === '/cities' ? Promise.resolve(answer(published)) : schedule,
	);
	const first = readTimetable(options);
	await first.loadCatalog();
	await expect(first.loadEdition('demo')).resolves.toBe(edition);
	// The speculative read was started before the first known revision.
	const warm = readTimetable(options);
	await warm.loadEdition('demo');
	await Promise.resolve();
	query.mockClear();
	await expect(readTimetable(options).loadEdition('demo')).resolves.toBe(edition);
	expect(query).not.toHaveBeenCalled();

	await vi.advanceTimersByTimeAsync(30_000);
	published = { ...catalog, answer_revision: 'fedcba9876543210' };
	schedule = refresh.promise;
	readTimetable(options);
	await Promise.resolve();
	const changed = readTimetable(options);
	await expect(changed.loadEdition('demo')).resolves.toBe(edition);
	expect(query.mock.calls.map(([question]) => question.path)).toEqual([
		'/cities',
		'/demo/schedule-index',
	]);
	refresh.resolve({ ...answer({ schedule: edition }), cacheStale: true });
	await vi.advanceTimersByTimeAsync(0);
	await expect(readTimetable(options).loadEdition('demo')).resolves.toBe(edition);

	await vi.advanceTimersByTimeAsync(30_000);
	schedule = Promise.resolve(answer({ schedule: newEdition }));
	readTimetable(options);
	await vi.advanceTimersByTimeAsync(0);
	await expect(readTimetable(options).loadEdition('demo')).resolves.toBe(newEdition);
});
