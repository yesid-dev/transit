import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

const page = readFileSync(new URL('../../../static/offline.html', import.meta.url), 'utf8');

it('says the offline message in Québec French with its accents', () => {
	expect(page).toContain('<p class="fr" lang="fr">');
	expect(page).toContain('Vous êtes hors ligne.');
	expect(page).toContain('données de transport collectif en temps réel');
	expect(page).toContain('<span lang="fr">Réessayer</span>');
	for (const unaccented of ['Vous etes', 'donnees', 'Reessayer', 'necessitent', 'de transit'])
		expect(page).not.toContain(unaccented);
});
