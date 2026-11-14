import { render } from '@testing-library/svelte';
import { expect, it, vi } from 'vitest';
import type { DataHealth, Manifest } from '#lib/v1/schemas/index.ts';
import HealthSummary from './HealthSummary.svelte';

const live = vi.hoisted(() => ({
	vehicles: null,
	familyStates: { vehicles: { health: {} as Record<string, unknown> } },
	start: () => {},
	stop: () => {},
}));
vi.mock('#lib/v1/live/store.svelte.ts', () => ({ createLiveStore: () => live }));
const files = { historic: { generated_utc: '2000-07-14' } };
const manifest = { provider: 'invented-network', tz: 'UTC', files } as unknown as Manifest;
const dataHealth = { lanes: [{ lane: 'rollup', gate: { verdict: 'pass' } }] } as DataHealth;
const props = { manifest, dataHealth, historyIndex: null, gaps: [], locale: 'en' as const };
const lines = (container: HTMLElement) =>
	[...container.querySelectorAll('p')].map((line) => ({
		shown: line.lastElementChild!.textContent,
		held: [...line.querySelectorAll('[aria-hidden="true"]')].map((hold) => hold.textContent),
	}));
const mount = (health: Record<string, unknown>) => {
	live.familyStates.vehicles.health = health;
	return lines(render(HealthSummary, props).container);
};

const failed = { retained: true, notice: 'refresh-unavailable', isStale: false, ageSeconds: 20 };
it.each([
	['a young payload after a failed refresh', { ...failed, state: 'retained-stale' }],
	['an old payload after a failed refresh', { ...failed, ageSeconds: 360, isStale: true }],
	['a payload during a retry', { ...failed, state: 'retrying' }],
])('says the live update time is unknown and never reassures for %s', (_, health) => {
	const [line1, , line3] = mount(health);
	expect([line1.shown, line3.shown]).toEqual(['Live · update time unknown', '']);
});

it('holds every line at the height of the sentences it may still show', async () => {
	live.familyStates.vehicles.health = { state: 'never-loaded' };
	const view = render(HealthSummary, props);
	const [line1, line2, line3] = lines(view.container);
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
		shown: '',
		held: ['Nothing known affects the figures on this site right now.'],
	});
	// The record line stays, at least as tall, when its dates arrive late (or never: no change).
	const historyIndex = { families: [{ family: 'network', last_available_date: '2000-07-13' }] };
	await view.rerender({ ...props, historyIndex: historyIndex as never });
	const record = lines(view.container)[1].shown!;
	expect([lines(view.container).length, record.length]).toEqual([3, line2.held[1]!.length]);
});
