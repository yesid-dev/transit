import { fireEvent, render, screen, within } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import StopsIndex from './StopsIndex.svelte';

const state = vi.hoisted(() => ({ url: new URL('http://localhost/stops?provider=stm') }));
vi.mock('$app/state', () => ({
	page: {
		get url() {
			return state.url;
		},
		state: {},
	},
}));
vi.mock('$app/navigation', () => ({
	replaceState: (url: string | URL) => {
		state.url = new URL(url, 'http://localhost');
	},
	afterNavigate: () => {},
	invalidateAll: vi.fn(),
}));
vi.mock('#lib/v1/repositories/static.ts', () => ({
	getStopsIndex: vi.fn(() => {
		throw new Error('Snapshot read');
	}),
	getRoutesIndex: vi.fn(() => {
		throw new Error('Snapshot read');
	}),
}));
import { getStopsIndex, getRoutesIndex } from '#lib/v1/repositories/static.ts';

const period = { from: '2026-11-04', to: '2026-11-10', preset: null };
const stops = Array.from({ length: 23 }, (_, index) => {
	const n = String(index + 1).padStart(2, '0');
	return {
		id: 'S' + n,
		name: 'Stop ' + n,
		code: '500' + n,
		lat: 45.5 + index * 0.001,
		lon: -73.6,
		routes: ['24'],
	};
});
const schedule = {
	date: '2026-11-10',
	stops,
	routes: [{ id: '24', short: '24', long: 'Sherbrooke', type: 3 }],
};
function show(hasSchedule = true) {
	return render(StopsIndex, {
		record: {
			city: 'stm',
			period,
			punctuality: Promise.resolve({ kind: 'unreachable' as const }),
		},
		schedule: hasSchedule ? schedule : null,
	});
}

beforeEach(() => {
	state.url = new URL('http://localhost/stops?provider=stm');
});
afterEach(() => {
	expect(getStopsIndex).not.toHaveBeenCalled();
	expect(getRoutesIndex).not.toHaveBeenCalled();
});

describe('the clean stops finder', () => {
	it('paginates the edition and carries its date range, city and stop identity into links', async () => {
		show();
		const table = screen.getByRole('table', { name: 'Stop results' });
		expect(within(table).getAllByRole('row')).toHaveLength(21);
		const link = within(table).getByRole('link', { name: 'Stop 01' });
		const target = new URL(link.getAttribute('href')!, state.url);
		expect(target.pathname).toBe('/stop/S01');
		expect(target.searchParams.get('provider')).toBe('stm');
		expect(target.searchParams.get('recordFrom')).toBe(period.from);
		expect(target.searchParams.get('recordTo')).toBe(period.to);

		await fireEvent.click(screen.getByRole('button', { name: /show.*3/i }));
		expect(within(table).getAllByRole('row')).toHaveLength(24);
	});

	it('can filter by published stop code and clear an unmatched query', async () => {
		show();
		const input = screen.getByTestId('stops-filter-input');
		await fireEvent.input(input, { target: { value: '50023' } });
		expect(screen.getByRole('link', { name: 'Stop 23' })).toBeVisible();
		expect(screen.queryByRole('link', { name: 'Stop 01' })).toBeNull();

		await fireEvent.input(input, { target: { value: 'unpublished' } });
		await fireEvent.click(screen.getByRole('button', { name: /clear filters/i }));
		expect(screen.getByRole('link', { name: 'Stop 01' })).toBeVisible();
	});

	it('offers a retry when the schedule is unavailable', () => {
		show(false);
		expect(screen.queryByRole('table')).toBeNull();
		expect(screen.getByRole('button', { name: /retry/i })).toBeVisible();
	});
});
