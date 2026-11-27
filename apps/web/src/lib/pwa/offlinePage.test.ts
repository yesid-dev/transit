import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

const page = readFileSync(new URL('../../../static/offline.html', import.meta.url), 'utf8');

it('says the offline message in Québec French with its accents', () => {
	expect(page).toContain('<p class="fr" lang="fr">');
	expect(page).toContain('Vous êtes hors ligne.');
	expect(page).toContain('bilan public du service de transport collectif');
	expect(page).toContain('<span lang="fr">Réessayer</span>');
	for (const unaccented of ['Vous etes', 'donnees', 'Reessayer', 'necessitent', 'de transit'])
		expect(page).not.toContain(unaccented);
});

it('describes the record, not the first site, with no long dash', () => {
	expect(page).toContain('<title>Offline · Transit</title>');
	expect(page).toContain('Transit is a public record of transit service');
	expect(page).not.toContain('real-time transit data');
	expect(page).not.toMatch(/[\u2013\u2014]/u);
});
