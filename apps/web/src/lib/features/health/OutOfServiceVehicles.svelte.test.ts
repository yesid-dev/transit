import { render, cleanup } from '@testing-library/svelte';
import { afterEach, describe, it, expect } from 'vitest';
import { VehicleSchema } from '#lib/v1/schemas/index.ts';
import type { LiveStore } from '#lib/v1/live/store.svelte.ts';
import OutOfServiceVehicles from './OutOfServiceVehicles.svelte';
const state = { vehicles: null as unknown };
const live = state as LiveStore;
afterEach(cleanup);
describe.each(['stm', 'octranspo'])('%s status count', (provider) => {
	it.each(['en', 'fr'] as const)('shows the count in %s', (locale) => {
		state.vehicles = {
			vehicles: ['trip', null, ''].map((trip, i) =>
				VehicleSchema.parse({
					id: provider + i,
					trip,
					lat: 45.5,
					lon: -73.6,
					status: 'unknown',
					updated_utc: '2026-06-15T00:00:00Z',
				}),
			),
		};
		const view = render(OutOfServiceVehicles, { live, locale });
		expect(
			view.getByText(
				locale === 'en' ? 'Out-of-service vehicles: 2' : /Véhicules hors service\s: 2/,
			),
		).toBeInTheDocument();
	});
	it('keeps unloaded data unknown', () => {
		state.vehicles = null;
		const view = render(OutOfServiceVehicles, { live, locale: 'en' });
		expect(view.queryByText(/Out-of-service vehicles/)).toBeNull();
		expect(view.queryByText(/—/)).toBeNull();
	});
});
