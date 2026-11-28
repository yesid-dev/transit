import { render, screen, within } from '@testing-library/svelte';
import { page } from '$app/state';
import type { ComponentProps } from 'svelte';
import { expect, it, vi } from 'vitest';
import VehicleFleet from './VehicleFleet.svelte';
import { fleetView, projectVehicleFleet } from './vehicleFleet.ts';

vi.mock('$app/state', () => ({
	page: { url: new URL('https://transit.test/vehicles?reporting=reported&q=40061'), data: {} },
}));
vi.mock('$app/navigation', () => ({ goto: vi.fn(), replaceState: vi.fn() }));

type FleetData = ComponentProps<typeof VehicleFleet>['data'];

it('keeps the filtered rows when the outgoing fleet receives vehicle detail data', async () => {
	const date = '2026-11-08';
	const view = fleetView(new URLSearchParams('reporting=reported&q=40061'));
	const data = {
		city: 'stm',
		mode: 'record',
		period: { from: date, to: date },
		seoTitle: 'Vehicles',
		view,
		fleet: {
			kind: 'answer',
			answer: projectVehicleFleet(
				{
					evidence: {
						start_date: date,
						end_date: date,
						days_included: [date],
						days_measured: [date],
						days_not_measured: [],
						cleaning_versions: [8],
						method_version: 'test',
						query_ms: 1,
					},
					coverage_note: null,
					cells: [
						{
							key: { vehicle: '40061' },
							state: 'measured',
							state_text: { en: 'Measured', fr: 'Mesuré' },
							value: { vehicle_days_in_service: 1 },
							evidence: { days_included: [date], counts: { hours_in_service: 3, trips_run: 4 } },
						},
					],
				},
				view,
				'en',
			),
		},
	} as FleetData;
	const { rerender } = render(VehicleFleet, { data });
	const row = () => within(screen.getByRole('table')).getByRole('link', { name: /^40061$/ });
	const outgoingRow = row();
	const outgoingLink = outgoingRow.getAttribute('href');

	// A detail route has the common period and city but no fleet view or reading.
	Object.assign(page, { url: new URL('https://transit.test/vehicle/40061') });
	await rerender({
		data: {
			city: 'stm',
			mode: 'record',
			period: data.period,
			seoTitle: 'Vehicle 40061',
		} as FleetData,
	});

	expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Vehicles');
	expect(screen.getByRole('searchbox', { name: 'Vehicle number' })).toHaveValue('40061');
	expect(row()).toBe(outgoingRow);
	expect(row()).toHaveAttribute('href', outgoingLink);

	const updatedView = fleetView(new URLSearchParams('q=0061'));
	Object.assign(page, { url: new URL('https://transit.test/vehicles?q=0061') });
	await rerender({ data: { ...data, view: updatedView } });
	expect(screen.getByRole('searchbox', { name: 'Vehicle number' })).toHaveValue('0061');
});
