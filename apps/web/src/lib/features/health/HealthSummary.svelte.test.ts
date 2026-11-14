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
const mount = (health: Record<string, unknown>, loading = false) => {
	live.familyStates.vehicles.health = health;
	const history = { data: null, loading, settled: !loading };
	const props = { manifest, dataHealth, history, gaps: [], locale: 'en' as const };
	return [...render(HealthSummary, props).container.querySelectorAll('p')].map((line) => ({
		shown: line.lastElementChild!.textContent,
		held: [...line.querySelectorAll('[aria-hidden="true"]')].map((hold) => hold.textContent),
	}));
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

it('holds every line at the height of the sentences it may still show', () => {
	const [line1, line2, line3] = mount({ state: 'never-loaded', retained: false }, true);
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
});
