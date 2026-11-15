import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { RecordStamp } from '#lib/v1/stamp.ts';
import { healthSummary } from './healthSummary';

const record: RecordStamp = {
	form: 'record',
	scope: 'window',
	dataThrough: '2026-11-10',
	publishedOn: '2026-11-11',
	nextUpdateUtc: null,
	warning: false,
};
const facts = { live: null, record, gate: null, gaps: [] };
const tz = 'America/Toronto';
beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date('2026-11-14T12:00:00Z'));
});
afterEach(() => vi.useRealTimers());

it.each([
	[
		{ ageSeconds: 20, isStale: false },
		'Up to date: live vehicle data, updated 20 seconds ago.',
		'À jour : les données en direct des véhicules, mises à jour il y a 20 secondes.',
		'current',
	],
	[
		{ ageSeconds: 360, isStale: true },
		'Not current: live vehicle data, last updated 6 minutes ago.',
		'Pas à jour : les données en direct des véhicules, dernière mise à jour il y a 6 minutes.',
		'behind',
	],
	[
		{ ageSeconds: null, isStale: true },
		'Live · update time unknown',
		'En direct · heure de mise à jour inconnue',
		'unknown',
	],
	[
		{ ageSeconds: 20, isStale: false, notice: 'refresh-unavailable' },
		'Live · update time unknown',
		'En direct · heure de mise à jour inconnue',
		'unknown',
	],
])(
	'column 1 says how old live vehicle data is (%o), with a matching mark',
	(live, en, fr, state) => {
		expect(healthSummary({ ...facts, live }, 'en', tz)).toMatchObject({
			live: en,
			liveState: state,
		});
		expect(healthSummary({ ...facts, live }, 'fr', tz).live).toBe(fr);
		expect(healthSummary(facts, 'en', tz)).toMatchObject({ live: null, liveState: null });
	},
);

it('column 2 says what the record covers, when it was published and, once published, its next update', () => {
	const line = (stamp: Partial<RecordStamp>, locale: 'en' | 'fr' = 'en') =>
		healthSummary({ ...facts, record: { ...record, ...stamp } }, locale, tz).record;
	expect(line({})).toBe(
		'The reliability record covers service through Nov 10. It was published on Nov 11.',
	);
	expect(line({}, 'fr')).toBe(
		'Le bilan de fiabilité couvre le service jusqu’au 10 nov. Il a été publié le 11 nov.',
	);
	expect(line({ nextUpdateUtc: '2026-11-18T07:00:00Z' })).toMatch(
		/Nov 11\. Next update: Nov 18\.$/,
	);
	expect(line({ nextUpdateUtc: '2026-11-18T07:00:00Z' }, 'fr')).toMatch(
		/11 nov\. Prochaine mise à jour : le 18 nov\.$/,
	);
	expect(line({ dataThrough: null })).toBe('Record · published Nov 11');
	// No date at all: say no record is published, never leave the column blank.
	expect(line({ dataThrough: null, publishedOn: null })).toBe(
		'No reliability record is published for this network.',
	);
	expect(line({ dataThrough: null, publishedOn: null }, 'fr')).toBe(
		'Aucun bilan de fiabilité n’est publié pour ce réseau.',
	);
});

it('column 2 says how the record’s publication check went, once data health has answered', () => {
	const check = (gate: object | null | undefined, locale: 'en' | 'fr' = 'en') =>
		healthSummary({ ...facts, gate: gate as never }, locale, tz).check;
	expect(check({ verdict: 'pass' })).toBe('The record’s last quality check passed.');
	expect(check({ verdict: 'pass' }, 'fr')).toBe(
		'Le dernier contrôle de qualité du bilan a réussi.',
	);
	expect(check({ verdict: 'warn', warnings: 1 })).toBe(
		'The last record was published with 1 warning. Line, stop and ranking figures come from it; check the date beside each figure.',
	);
	expect(check({ verdict: 'warn', warnings: 1 }, 'fr')).toBe(
		'Le dernier bilan a été publié avec 1 avertissement. Les chiffres des lignes, des arrêts et des classements en proviennent; vérifiez la date à côté de chaque chiffre.',
	);
	expect(check({ verdict: 'warn', warnings: 2 })).toMatch(
		/^The last record was published with 2 warnings\./,
	);
	expect(check({ verdict: 'fail', errors: 2, warnings: 3 })).toBe(
		'The last record was published even though its quality check failed. Line, stop and ranking figures come from it and may be wrong; check the date beside each figure.',
	);
	expect(check({ verdict: 'fail' }, 'fr')).toBe(
		'Le dernier bilan a été publié même si son contrôle de qualité a échoué. Les chiffres des lignes, des arrêts et des classements en proviennent et peuvent être erronés; vérifiez la date à côté de chaque chiffre.',
	);
	// Published data health without a record check is a missing result, never a pass.
	expect(check(null)).toBe('No quality check result is published for the record.');
	expect(check(null, 'fr')).toBe(
		'Aucun résultat de contrôle de qualité n’est publié pour le bilan.',
	);
	// Not loaded yet, an unknown verdict or an uncounted warning: nothing is claimed.
	for (const unsure of [undefined, { verdict: 'unknown' }, { verdict: 'warn', warnings: null }])
		expect(check(unsure)).toBeNull();
});

it('column 3 lists known limitations, reassures only on a passed check and current live data', () => {
	const current = { ageSeconds: 20, isStale: false };
	const pass = { verdict: 'pass' };
	const limits = (more: object, locale: 'en' | 'fr' = 'en') =>
		healthSummary({ ...facts, ...more }, locale, tz).limits;
	const unconfirmed =
		'No limitation is declared, but nothing can be confirmed until live data is current and the record’s check has passed.';
	expect(limits({ live: current, gate: pass })).toBe(
		'Nothing known affects the figures on this site right now.',
	);
	expect(limits({ live: current, gate: pass }, 'fr')).toBe(
		'Rien de connu n’affecte les chiffres de ce site en ce moment.',
	);
	for (const unsure of [
		{ live: { ageSeconds: 360, isStale: true }, gate: pass },
		{ live: { ageSeconds: 20, isStale: false, notice: 'refresh-unavailable' }, gate: pass },
		{ live: null, gate: pass },
		{ live: current, gate: null },
		{ live: current, gate: undefined },
		{ live: current, gate: { verdict: 'warn', warnings: 1 } },
		{ live: current, gate: { verdict: 'fail' } },
	])
		expect(limits(unsure)).toBe(unconfirmed);
	expect(limits({}, 'fr')).toBe(
		'Aucune limite n’est déclarée, mais rien ne peut être confirmé tant que les données en direct ne sont pas à jour et que le contrôle du bilan n’a pas réussi.',
	);
	expect(limits({ live: current, gate: pass, gaps: ['metro_realtime'] })).toBe(
		'Nothing known affects the figures on this site right now. Not measured: Metro. These lines publish no live data.',
	);
	expect(limits({ gate: { verdict: 'fail' }, gaps: ['otrain_realtime', 'new_gap'] }, 'fr')).toBe(
		'Non mesuré : O-Train, new gap. Ces lignes ne publient aucune donnée en direct.',
	);
});
