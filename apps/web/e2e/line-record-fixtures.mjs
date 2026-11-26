const montreal = {
	51: {
		short: '51',
		long: 'Édouard-Montpetit',
		type: 3,
		ends: ['Est', 'Ouest'],
		stops: [
			'Gare Montréal-Ouest',
			'Westminster / Sherbrooke',
			'Fielding / Walkley',
			'Fielding / Cavendish',
			'Fielding / Kensington',
			'Fielding / West Hill',
			'Côte-Saint-Luc / West Hill',
			'Côte-Saint-Luc / Grand',
			'Queen-Mary / Décarie',
			'Station Snowdon',
			'Queen-Mary / Côte-des-Neiges',
			'Station Côte-des-Neiges',
			'Édouard-Montpetit / Louis-Colin',
			'Édouard-Montpetit / Vincent-d’Indy',
			'Station Édouard-Montpetit',
			'Saint-Joseph / Côte-Sainte-Catherine',
			'Saint-Joseph / du Parc',
			'Saint-Joseph / Saint-Laurent',
			'Station Laurier',
		],
	},
	m2: { short: '2', long: 'Métro ligne orange', type: 1, ends: ['Montmorency', 'Côte-Vertu'] },
	715: {
		short: '715',
		long: 'Vieux-Montréal / Vieux-Port',
		type: 3,
		ends: ['Station Berri-UQAM', 'Station Peel'],
	},
};
const ottawa = {
	80: {
		short: '80',
		long: 'Merivale ~ Merivale',
		type: 3,
		ends: ['Tunney’s Pasture ~ Pré Tunney', 'Barrhaven Centre ~ Centre Barrhaven'],
		stops: [
			'Barrhaven Centre',
			'Fallowfield',
			'Merivale / Viewmount',
			'Merivale / Baseline',
			'Carling / Merivale',
			'Tunney’s Pasture',
		],
	},
};

export function lineRecordFixture(city, id) {
	return (city === 'stm' ? montreal : ottawa)[id];
}

export function installLineRecordFixtures(city, routes, directions, stops) {
	for (const [id, { short, long, type, ends, stops: names = [] }] of Object.entries(
		city === 'stm' ? montreal : ottawa,
	)) {
		routes.set(id, { id, short, long, type });
		const items = names.map((name, index) => {
			const stop = {
				id: `record-fixture-${id}-${index}`,
				name,
				code: String((city === 'stm' ? 52800 : 3100) + index),
				lat: city === 'stm' ? 45.5 : 45.4,
				lon: city === 'stm' ? -73.6 : -75.7,
				routes: [id],
			};
			stops.set(stop.id, stop);
			return stop;
		});
		directions[id] = ends.map((headsign, dir) => ({
			dir,
			headsign,
			stops: (dir ? items.toReversed() : items).map(({ id, name }, index) => ({
				id,
				name,
				seq: index + 1,
			})),
		}));
	}
}

export function namedLineCells(line, route, group, direction, cell, from) {
	if (group === 'departure') {
		return [
			{ dir: 0, departure: '07:00:00', scheduled: 800, cancelled: 5, missing: 12 },
			{ dir: 1, departure: '15:45:00', scheduled: 777, cancelled: 7, missing: 20 },
		]
			.filter(({ dir }) => direction == null || dir === direction)
			.map(({ dir, departure, scheduled, cancelled, missing }) => {
				const ran = scheduled - cancelled - missing;
				return cell(
					{ direction: dir, departure },
					{ trips_run: ran / scheduled },
					{ counts: { scheduled, cancelled, missing, ran } },
				);
			});
	}
	if (group === 'day') {
		return Array.from({ length: 7 }, (_, index) => {
			const day = new Date(Date.parse(from) + index * 86400000).toISOString().slice(0, 10);
			const onTime = [0.747, 0.785, 0.816, 0.778, 0.737, 0.727, 0.733][index];
			return cell({ day }, { on_time: onTime });
		});
	}
	if (group === 'weekday_hour') {
		return Array.from({ length: 7 }, (_, weekday) =>
			Array.from({ length: 20 }, (_, slot) => {
				const hour = (slot + 5) % 24;
				const late = (11 + (weekday % 3) * 3 + ((hour + 2) % 7) * 2 + (hour === 17 ? 8 : 0)) / 100;
				return cell({ weekday: weekday + 1, hour }, { late });
			}),
		).flat();
	}
	if (group === 'stop' && route.stops) {
		const delays = [
			0, 12, 30, 42, 0, 18, 36, 25, 70, 130, 190, 255, 305, 292, 315, 282, 330, 344, 325,
		];
		return (direction == null ? [0, 1] : [direction]).flatMap((dir) =>
			route.stops.map((_, index, items) => {
				const stopIndex = dir ? items.length - index - 1 : index;
				return cell(
					{ direction: dir, stop_sequence: index + 1, stop: `record-fixture-${line}-${stopIndex}` },
					{ median_delay: delays[index] },
				);
			}),
		);
	}
	return undefined;
}

export function namedSchedulePeriods(line) {
	const scale = line === 'm2' ? 3 : line === '715' ? 0.35 : 1;
	return [
		[0, 5, 'Overnight', 'Nuit', 2],
		[5, 9, 'Morning', 'Matin', 12],
		[9, 15, 'Midday', 'Milieu de journée', 8],
		[15, 19, 'Afternoon', 'Après-midi', 10],
		[19, 24, 'Evening', 'Soirée', 6],
	].map(([start_hour, end_hour, en, fr, hourly]) => {
		const scheduled_clock_hours = end_hour - start_hour;
		const scheduled_trips = Math.round(hourly * scale * scheduled_clock_hours);
		return {
			start_hour,
			end_hour,
			period_text: { en, fr },
			day_type: 'weekday',
			days: 1,
			scheduled_clock_hours,
			scheduled_trips,
			scheduled_frequency: scheduled_trips / scheduled_clock_hours,
		};
	});
}
