import type { Page } from '@playwright/test';

const stops = [
	{ id: 'MR1', name: 'Mont-Royal', lat: 45.51, lon: -73.583, routes: ['24'] },
	{ id: 'MR2', name: 'Laurier', lat: 45.525, lon: -73.585, routes: ['24'] },
	{ id: 'MR3', name: 'Rosemont', lat: 45.535, lon: -73.599, routes: ['24'] },
	{ id: 'MR4', name: 'Beaubien', lat: 45.541, lon: -73.608, routes: ['24'] },
	{ id: 'MR5', name: 'Jean-Talon', lat: 45.547, lon: -73.621, routes: ['24'] },
];
const ottawaStops = [
	{ id: 'MR1', name: 'RIDEAU', lat: 45.425, lon: -75.69, routes: ['24'] },
	{ id: 'MR2', name: 'WALLER', lat: 45.426, lon: -75.685, routes: ['24'] },
	{ id: 'MR3', name: 'LAURIER', lat: 45.422, lon: -75.683, routes: ['24'] },
	{ id: 'MR4', name: 'SOMERSET', lat: 45.417, lon: -75.688, routes: ['24'] },
	{ id: 'MR5', name: 'GLADSTONE', lat: 45.412, lon: -75.691, routes: ['24'] },
];

export async function recordMapFixture(
	page: Page,
	networkAvailable = true,
	provider = 'stm',
	coverage: 'partial' | 'complete' = 'partial',
) {
	const locations = provider === 'octranspo' ? ottawaStops : stops;
	const received: URLSearchParams[] = [];
	await page.clock.setFixedTime(new Date('2026-11-23T16:00:00Z'));
	await page.route(`**/api/stops/slim?provider=${provider}`, (route) =>
		route.fulfill({ json: { generated_utc: '2026-11-21T00:00:00Z', stops: locations } }),
	);
	await page.route(`**/api/corridor-map?city=${provider}`, (route) => {
		const destinations = coverage === 'complete' ? locations.slice(1) : locations.slice(1, 2);
		return route.fulfill({
			json: {
				schedule: {
					date: '2026-11-21',
					paths: destinations.map((second, index) => {
						const first = locations[index]!;
						return [
							'24',
							0,
							first.id,
							second.id,
							[
								[first.lon, first.lat],
								[second.lon, first.lat],
								[second.lon, second.lat],
							],
						];
					}),
				},
			},
		});
	});
	await page.route(`**/api/schedule-edition?city=${provider}`, (route) =>
		route.fulfill({
			json: {
				schedule: {
					date: '2026-11-21',
					routes: [{ id: '24', short: '24', long: 'Sherbrooke', type: 3 }],
					route_directions: {
						24: [
							{
								dir: 0,
								headsign: locations.at(-1)?.name,
								stops: locations.map(({ id }, seq) => ({ id, seq })),
							},
						],
					},
					stops: locations,
				},
			},
		}),
	);
	await page.route('**/api/map-record?**', (route) => {
		const params = new URL(route.request().url()).searchParams;
		received.push(params);
		const evidence = { days_not_measured: [] };
		const network = params.get('layer') === 'corridors' && !params.has('line');
		if (network && !networkAvailable) {
			return route.fulfill({ status: 409, json: { state: 'choose_line' } });
		}
		return route.fulfill({
			json:
				params.has('line') || network
					? {
							measure: 'mean_time_lost',
							...(network
								? { lines: [['24'], ['24'], ['24'], ['24']] }
								: { direction: [0, 0, 0, 0] }),
							from_stop: ['MR1', 'MR2', 'MR3', 'MR4'],
							to_stop: ['MR2', 'MR3', 'MR4', 'MR5'],
							state: [3, 1, 0, 2],
							value: [42, null, null, null],
							sample: [34, 6, 0, 0],
							evidence,
						}
					: {
							measure: 'late',
							stop: ['MR1', 'MR2', 'MR3', 'MR4', 'MR5'],
							state: [3, 1, 0, 2, 3],
							value: [0, null, null, null, 550],
							sample: [45, 12, 0, 0, 60],
							evidence,
						},
		});
	});
	return received;
}

export const recordMapPeriod =
	'provider=stm&frameMode=record&recordFrom=2026-11-18&recordTo=2026-11-21';
