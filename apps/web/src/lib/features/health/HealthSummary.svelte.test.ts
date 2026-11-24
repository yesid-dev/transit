import { render } from '@testing-library/svelte';
import { expect, it, vi } from 'vitest';
import type { DataHealth, Manifest } from '#lib/v1/schemas/index.ts';
import type { LiveStore } from '#lib/v1/live/store.svelte.ts';
import HealthSummary from './HealthSummary.svelte';

const live = vi.hoisted(() => ({
	vehicles: null,
	familyStates: { vehicles: { health: {} as Record<string, unknown> } },
	start: () => {},
	stop: () => {},
}));
const files = { historic: { generated_utc: '2000-07-14' } };
const manifest = { provider: 'invented-network', tz: 'UTC', files } as unknown as Manifest;
const dataHealth = { lanes: [{ lane: 'rollup', gate: { verdict: 'pass' } }] } as DataHealth;
const props = {
	manifest,
	live: live as unknown as LiveStore,
	dataHealth,
	historyIndex: null,
	gaps: [],
	locale: 'en' as const,
};
const lines = (container: HTMLElement) =>
	[...container.querySelectorAll('[data-slot="health-reading"]')].map((line) => ({
		shown: line.lastElementChild!.textContent,
		held: [...line.querySelectorAll('[aria-hidden="true"]')].map((hold) => hold.textContent),
	}));
const mount = (health: Record<string, unknown>) => {
	live.familyStates.vehicles.health = health;
	return lines(render(HealthSummary, props).container);
};

const unconfirmed =
	'No limitation is declared, but nothing can be confirmed until live data is current and the record’s check has passed.';
const failed = { retained: true, notice: 'refresh-unavailable', isStale: false, ageSeconds: 20 };
it.each([
	['a young payload after a failed refresh', { ...failed, state: 'retained-stale' }],
	['an old payload after a failed refresh', { ...failed, ageSeconds: 360, isStale: true }],
	['a payload during a retry', { ...failed, state: 'retrying' }],
])('says the live update time is unknown and never reassures for %s', (_, health) => {
	const [live, , , limits] = mount(health);
	expect([live.shown, limits.shown]).toEqual(['Live · update time unknown', unconfirmed]);
});

it('answers in three labelled columns: live data, published records, known limitations', () => {
	live.familyStates.vehicles.health = { state: 'ready', ageSeconds: 20, isStale: false };
	const view = render(HealthSummary, props);
	const columns = [...view.container.querySelectorAll('section')];
	expect(columns.map((column) => column.getAttribute('aria-labelledby'))).toEqual([
		'health-answer-live',
		'health-answer-record',
		'health-answer-limits',
	]);
	expect(columns.map((column) => column.querySelector('h3')!.textContent!.trim())).toEqual([
		'Live data',
		'Published records',
		'Known limitations',
	]);
	expect(columns[0]!.querySelector('[data-state]')).toHaveAttribute('data-state', 'current');
	expect(lines(columns[1]!).map((line) => line.shown)).toEqual([
		'Record · published Jul 14, 2000',
		'The record’s last quality check passed.',
	]);
	expect(lines(columns[2]!)[0]!.shown).toBe(
		'Nothing known affects the figures on this site right now.',
	);
});

it('says the record check is not published only once data health has answered without one', async () => {
	live.familyStates.vehicles.health = { state: 'ready', ageSeconds: 20, isStale: false };
	const view = render(HealthSummary, { ...props, dataHealth: null });
	const check = () => lines(view.container)[2]!;
	expect(check().shown).toBe('');
	await view.rerender({ ...props, dataHealth: { lanes: [{ lane: 'live' }] } as DataHealth });
	expect(check().shown).toBe('No quality check result is published for the record.');
	expect(lines(view.container)[3]!.shown).toBe(unconfirmed);
	// Settled without a document (failed or not published): unknown, said in words.
	await view.rerender({ ...props, dataHealth: null, dataHealthSettled: true });
	expect(check().shown).toBe(
		'Data health is not available, so the result of the record’s quality check is unknown.',
	);
});

it('holds every line at the height of the sentences it may still show', async () => {
	live.familyStates.vehicles.health = { state: 'never-loaded' };
	const view = render(HealthSummary, props);
	const [line1, line2, line3, line4] = lines(view.container);
	expect(line1).toEqual({
		shown: '',
		held: [
			'Up to date: live vehicle data, updated 59 minutes ago.',
			'Not current: live vehicle data, last updated 59 minutes ago.',
			'Live · update time unknown',
		],
	});
	expect(line2.held).toEqual([
		'Record · published Jul 14, 2000',
		'The reliability record covers service through Jul 14, 2000. It was published on Jul 14, 2000.',
	]);
	expect(line3).toEqual({
		shown: 'The record’s last quality check passed.',
		held: ['The record’s last quality check passed.'],
	});
	expect(line4).toEqual({
		shown: unconfirmed,
		held: ['Nothing known affects the figures on this site right now.', unconfirmed],
	});
	// The record line stays, at least as tall, when its dates arrive late (or never: no change).
	const historyIndex = { families: [{ family: 'network', last_available_date: '2000-07-13' }] };
	await view.rerender({ ...props, historyIndex: historyIndex as never });
	const record = lines(view.container)[1].shown!;
	expect([lines(view.container).length, record.length]).toEqual([4, line2.held[1]!.length]);
});
