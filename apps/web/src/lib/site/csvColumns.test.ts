import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { measureLabel, spreadsheetColumns } from './csvColumns.ts';

// Every ID the engine can put in a CSV's Measure column: its measures and its families.
function engineIds() {
	const source = (name: string) =>
		readFileSync(new URL(`../../../../engine/src/transit_engine/${name}`, import.meta.url), 'utf8');
	const measures = source('measures.py');
	const constants = new Map(
		[
			...`${measures}\n${source('scorecard.py')}`.matchAll(
				/^_?([A-Z][A-Z0-9_]*) = "([a-z0-9_]+)"/gmu,
			),
		].map(([, name, id]) => [name!, id!]),
	);
	const measureIds = [...measures.matchAll(/Measure\(\s*"([a-z0-9_]+)"/gu)].map(([, id]) => id!);
	const familyIds = [
		...measures.matchAll(/Family\(\s*id=(?:"([a-z0-9_]+)"|_?([A-Z][A-Z0-9_]*))/gu),
	].map(([, literal, name]) => literal ?? constants.get(name!.replace(/^_/u, ''))!);
	return { measureIds, familyIds };
}

it('names every measure and family the engine can export, in both languages', () => {
	const { measureIds, familyIds } = engineIds();
	expect(measureIds.length).toBeGreaterThan(30);
	expect(familyIds.length).toBeGreaterThan(10);
	expect(familyIds).toContain('alert_counts');
	for (const id of [...measureIds, ...familyIds])
		for (const lang of ['en', 'fr'] as const)
			expect(measureLabel(id, lang), `${id} in ${lang}`).not.toBe(id);
});

it('lists a downloaded file’s columns as the file has them', () => {
	expect(spreadsheetColumns(['Measure', 'Value', 'Unit'], 'en')).toEqual([
		'Measure ID',
		'Measure',
		'Value',
		'Unit',
		'Data source and licence',
		'Licence URL',
	]);
	expect(spreadsheetColumns(['Rang', 'Type'], 'fr')).toEqual([
		'Rang',
		'Type',
		'Source des données et licence',
		'Adresse de la licence',
	]);
});
