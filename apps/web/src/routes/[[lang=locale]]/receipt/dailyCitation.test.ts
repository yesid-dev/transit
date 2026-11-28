import { describe, expect, it } from 'vitest';
import { dailySectionCitation } from './dailyCitation.ts';

const parts = {
	subject: 'Daily report, Montréal',
	section: 'Early, on time and late',
	period: { from: '2026-11-17', to: '2026-11-17' },
	statement: '71.0% of recorded stop arrivals were on time.',
	method: 'Method v3.',
	source: { agency: { name: 'STM', frenchOf: 'de la STM' }, licence: 'CC BY 4.0' },
	href: 'https://transit.test/receipt#punctuality',
	accessed: '2026-11-27',
};

describe('dailySectionCitation', () => {
	it('carries the source, licence and access day like every page citation', () => {
		expect(dailySectionCitation(parts, 'en')).toBe(
			'Transit · Daily report, Montréal. Early, on time and late. 17 Nov 2026. 71.0% of recorded stop arrivals were on time. Method v3. Source: STM open data, CC BY 4.0, computed by Transit. Accessed 27 Nov 2026. https://transit.test/receipt#punctuality',
		);
	});

	it('says the same in Québec French', () => {
		const text = dailySectionCitation(
			{
				...parts,
				subject: 'Rapport quotidien, Montréal',
				section: 'En avance, à l’heure et en retard',
			},
			'fr',
		);
		expect(text).toContain(
			'Source\u00a0: données ouvertes de la STM, CC BY 4.0, calculs de Transit.',
		);
		expect(text).toContain('Consulté le 27 nov. 2026.');
		expect(text.endsWith(' https://transit.test/receipt#punctuality')).toBe(true);
	});

	it('leaves out a missing statement and note', () => {
		const { statement: _statement, ...rest } = parts;
		expect(dailySectionCitation(rest, 'en')).not.toMatch(/ {2}|\.\./u);
	});
});
