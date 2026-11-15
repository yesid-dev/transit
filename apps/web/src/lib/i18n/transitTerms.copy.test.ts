import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { methodSearchAliases, transitTerms } from './transitTerms.copy.ts';

const MODULE_URL = new URL('./transitTerms.copy.ts', import.meta.url).href;
const LOCALES = ['en', 'fr'] as const;

// A caller-owned link: the visible label, then the line identity for screen readers.
function openRecordLink(locale: (typeof LOCALES)[number], number: string, name: string) {
	const words = transitTerms[locale];
	const text = words.action.openRecord;
	return { text, accessibleName: `${text}, ${words.line} ${number} ${name}` };
}

// Every plain string a page could show; the one count function has its own test.
function displayStrings(value: unknown): string[] {
	if (typeof value === 'string') return [value];
	if (value !== null && typeof value === 'object') {
		return Object.values(value).flatMap(displayStrings);
	}
	return [];
}

describe('transit vocabulary', () => {
	it('loads in plain Node, as the B9 scripts load copy, with no runtime import', () => {
		const run = spawnSync(
			process.execPath,
			[
				'--input-type=module',
				'--eval',
				'const { transitTerms } = await import(process.argv[1]); process.stdout.write(transitTerms.fr.reading);',
				MODULE_URL,
			],
			{ encoding: 'utf8' },
		);
		expect(run.stderr).toBe('');
		expect(run.stdout).toBe('Relevé');
	});

	it('gives English and French the same keys, kinds and non-empty words', () => {
		const shape = (value: unknown, path = ''): string[] =>
			value !== null && typeof value === 'object'
				? Object.entries(value).flatMap(([key, item]) => shape(item, `${path}/${key}`))
				: [`${path}:${typeof value}`];
		for (const copy of [transitTerms, methodSearchAliases]) {
			expect(shape(copy.en)).toEqual(shape(copy.fr));
		}
		for (const locale of LOCALES) {
			for (const label of displayStrings(transitTerms[locale])) {
				expect(label.trim()).not.toBe('');
			}
		}
	});

	it('composes an action whose spoken name keeps its visible label', () => {
		expect(openRecordLink('en', '24', 'Sherbrooke')).toEqual({
			text: 'Open record',
			accessibleName: 'Open record, Line 24 Sherbrooke',
		});
		expect(openRecordLink('fr', '24', 'Sherbrooke')).toEqual({
			text: 'Ouvrir le bilan',
			accessibleName: 'Ouvrir le bilan, Ligne 24 Sherbrooke',
		});
		// Every action is a plain verb phrase a caller can put first in a spoken name.
		for (const locale of LOCALES) {
			for (const label of Object.values(transitTerms[locale].action)) {
				expect(label).toMatch(/^\p{Lu}[^<>{}.,:;…]*$/u);
			}
		}
	});

	it('tells a silent trip from a missing one, and a vehicle state from trip states', () => {
		expect(transitTerms.en.trip).toMatchObject({ silent: 'Silent trip', missing: 'Missing trip' });
		expect(transitTerms.fr.trip).toMatchObject({
			silent: 'Trajet silencieux',
			missing: 'Trajet manquant',
		});
		for (const locale of LOCALES) {
			const { trip, vehicle } = transitTerms[locale];
			const tripNoun = trip.noun.toLowerCase();
			for (const state of [trip.cancelled, trip.silent, trip.missing]) {
				expect(state.toLowerCase()).toContain(tripNoun);
			}
			expect(vehicle.noRecentPosition.toLowerCase()).not.toContain(tripNoun);
			expect(vehicle.noun).not.toBe(trip.noun);
		}
	});

	it('names the three bands, and keeps an unknown delay out of them', () => {
		expect(Object.values(transitTerms.en.band)).toEqual(['On time', 'Early', 'Late']);
		expect(Object.values(transitTerms.fr.band)).toEqual(['À l’heure', 'En avance', 'En retard']);
		expect(transitTerms.en.delayUnknown).toBe('Delay unknown');
		expect(transitTerms.fr.delayUnknown).toBe('Retard inconnu');
	});

	it('counts complete days around a number the caller already formatted', () => {
		expect(transitTerms.en.completeDays(7, '7')).toBe('7 complete days');
		expect(transitTerms.en.completeDays(1, '1')).toBe('1 complete day');
		expect(transitTerms.en.completeDays(0, '0')).toBe('0 complete days');
		expect(transitTerms.fr.completeDays(7, '7')).toBe('7 jours complets');
		expect(transitTerms.fr.completeDays(1, '1')).toBe('1 jour complet');
		expect(transitTerms.fr.completeDays(0, '0')).toBe('0 jour complet');
		expect(transitTerms.fr.completeDays(1200, '1\u00a0200')).toBe('1\u00a0200 jours complets');
	});

	it('keeps Ghost bus a method-search alias, never a displayed name', () => {
		expect(methodSearchAliases.en.trip).toEqual({ silent: ['Ghost bus'], missing: ['Ghost bus'] });
		expect(methodSearchAliases.fr.trip).toEqual({
			silent: ['Bus fantôme'],
			missing: ['Bus fantôme'],
		});
		// Words the glossary retires: bus names, "worst", ridership, Route, voyage, mesure, old silent wording.
		const retired =
			/ghost|fantôme|\bbus\b|autobus|worst|pire|achalandage|\broute\b|voyage|\bmesure\b|sans signal/i;
		for (const locale of LOCALES) {
			const shown = displayStrings(transitTerms[locale]);
			expect(shown.length).toBeGreaterThan(0);
			expect(shown.filter((label) => retired.test(label))).toEqual([]);
		}
	});
});
