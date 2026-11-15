import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { lineViewsCopy } from './lineViews.copy';

// Revision 2 status is computed in seconds upstream, before the displayed minute is rounded.
// Keep this explanation tied to both actual publisher owners until a new method ships.
const helpers = readFileSync(
	new URL('../../../../../db/src/transit_ops/snapshots/builders/_helpers.py', import.meta.url),
	'utf8',
);
const migration = readFileSync(
	new URL(
		'../../../../../db/src/transit_ops/db/migrations/versions/0093_alert_publication_provenance.py',
		import.meta.url,
	),
	'utf8',
);
describe('published revision-2 line status definition', () => {
	it('describes the owning publisher thresholds, including each exclusive upper limit', () => {
		const sql = helpers.split('STATUS_BAND_CASE_SQL = """')[1].split('"""')[0];
		const seconds = [...sql.matchAll(/\{col\}\s*<\s*(-?\d+)/g)].map((match) => Number(match[1]));
		expect(seconds).toEqual([-60, 60, 300]);
		const view =
			migration.split('CREATE OR REPLACE VIEW gold.current_vehicle_map_with_status')[1] ??
			migration.split('CREATE VIEW gold.current_vehicle_map_with_status')[1];
		expect(view).toBeDefined();
		const vehicleCase = view.split('END AS status_band')[0];
		const vehicleSeconds = [...vehicleCase.matchAll(/<\s*\(?'?(-?\d+)/g)].map((match) =>
			Number(match[1]),
		);
		expect(vehicleSeconds).toEqual(seconds);
		for (const locale of ['en', 'fr'] as const) {
			const numbers = [...lineViewsCopy[locale].bands.matchAll(/[−-]?\d+/g)].map((match) =>
				Number(match[0].replace('−', '-')),
			);
			expect(numbers).toEqual([2, -1, -1, 1, 1, 5, 5]);
		}
	});
});
