import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

const page = readFileSync(new URL('../../../static/offline.html', import.meta.url), 'utf8');

it('gives each language its own heading and retry action', () => {
	expect(page).toContain('<h1>Vous êtes hors ligne</h1>');
	expect(page).toContain('le bilan du service');
	expect(page).toContain('<a href="">Réessayer</a>');
	expect(page).toContain('<h1>You are offline</h1>');
	expect(page).toContain('<a href="">Try again</a>');
	expect(page).toContain('document.documentElement.lang');
	expect(page).toContain('prefers-color-scheme');
});
