import { describe, it, expect } from 'vitest';
import { selectAffectedCounts } from './affectedCounts';

const labels = {
	routes: 'Lines',
	stops: 'Stops',
	alerts: 'Alerts',
	vehicles: 'Vehicles',
	noAlertFeed: 'No alert feed',
	hasAlertFeed: true,
	fmtCount: (v: number | null | undefined) => (v == null ? null : String(v)),
};
const alertsOf = (alerts: number | null, hasAlertFeed: boolean) =>
	selectAffectedCounts(
		{ affectedRoutes: 1, affectedStops: 1, alerts, vehicles: null },
		{ ...labels, hasAlertFeed },
	).find((c) => c.key === 'alerts')?.value;

describe('selectAffectedCounts', () => {
	it('builds routes/stops/alerts cells and OMITS the always-null vehicles cell', () => {
		const cells = selectAffectedCounts(
			{ affectedRoutes: 12, affectedStops: 340, alerts: 5, vehicles: null },
			labels,
		);
		expect(cells.map((c) => c.key)).toEqual(['routes', 'stops', 'alerts']);
		expect(cells.find((c) => c.key === 'vehicles')).toBeUndefined();
	});

	it('surfaces the vehicles cell only when a real count exists', () => {
		const cells = selectAffectedCounts(
			{ affectedRoutes: 12, affectedStops: 340, alerts: 5, vehicles: 220 },
			labels,
		);
		expect(cells.find((c) => c.key === 'vehicles')?.value).toBe('220');
	});

	it('renders null (styled chip) for a null count, a real 0 stays 0', () => {
		const cells = selectAffectedCounts(
			{ affectedRoutes: null, affectedStops: 0, alerts: null, vehicles: null },
			labels,
		);
		expect(cells.find((c) => c.key === 'routes')?.value).toBeNull();
		expect(cells.find((c) => c.key === 'stops')?.value).toBe('0');
	});

	it('says there is no alert feed instead of a zero or missing alert count', () => {
		expect(alertsOf(0, false)).toBe('No alert feed');
		expect(alertsOf(null, false)).toBe('No alert feed');
		expect(alertsOf(0, true)).toBe('0');
		expect(alertsOf(null, true)).toBeNull();
		expect(alertsOf(3, false)).toBe('3');
	});
});
