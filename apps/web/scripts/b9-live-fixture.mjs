const readings = [
	-360,
	-180,
	-60,
	...Array(20).fill(0),
	60,
	...Array(6).fill(180),
	360,
	660,
	660,
	960,
	null,
	null,
	null,
];
const occupancyCounts = [3, 11, 10, 8, 5];
const occupancyCodes = [0, 1, 2, 3, 5];

export function b9LiveFixture(fixture) {
	const previous = fixture.files['live/network.json'];
	const stamp = previous.generated_utc;
	const rich = previous.vehicles_in_service > 0;
	const feed = (family) => ({
		family,
		captured_at: stamp,
		source_at: stamp,
		// The display oracle replays a frozen publication against the host SSR clock.
		fresh_for_seconds: 63_072_000,
		source_lag_seconds: 0,
		read_failed: false,
	});
	const occupancy = occupancyCounts.flatMap((count, i) => Array(count).fill(occupancyCodes[i]));
	const snapshot = {
		version: 2,
		city: 'stm',
		published_at: stamp,
		stable_vehicle_ids: true,
		feeds: { vehicle_positions: feed('vehicle_positions'), trip_updates: feed('trip_updates') },
		vehicle_positions: !rich
			? []
			: readings.map((delay, i) => ({
					id: `fixture-${i}`,
					vehicle_id: `fixture-${i}`,
					trip_id: null,
					start_date: null,
					start_time: null,
					route_id: '24',
					direction_id: null,
					latitude: 45.5,
					longitude: -73.6,
					bearing: null,
					speed_mps: null,
					stop_id: null,
					stop_sequence: null,
					status: null,
					occupancy: occupancy[i],
					occupancy_percentage: null,
					observed_at: stamp,
					delay,
				})),
		alerts: null,
	};
	const expectation = {
		generated_utc: stamp,
		vehicles_in_service: rich ? 37 : 0,
		on_time_pct: rich ? 82 : null,
		coverage_pct: rich ? 92 : null,
		delay_p50_min: rich ? 0 : null,
		delay_p90_min: rich ? 5 : null,
		non_responding: null,
		status_dist: rich ? { early: 2, on_time: 21, late: 7, severe: 4, unknown: 3 } : null,
		occupancy_mix: rich
			? { empty: 3 / 37, many_seats: 11 / 37, few_seats: 10 / 37, standing: 8 / 37, full: 5 / 37 }
			: null,
		delay_histogram: !rich
			? null
			: [
					[null, -5, 1],
					[-5, -2, 1],
					[-2, 0, 1],
					[0, 2, 21],
					[2, 5, 6],
					[5, 10, 1],
					[10, 15, 2],
					[15, null, 1],
				].map(([lo_min, hi_min, count]) => ({ lo_min, hi_min, count })),
	};
	return { snapshot, expectation };
}
