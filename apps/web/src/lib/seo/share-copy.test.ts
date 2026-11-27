import { expect, it } from 'vitest';
import { resolveRouteSeo } from './routeSeo';
import { shareCopy } from './share-copy';
const paths = [
	'/',
	'/map',
	'/lines',
	'/stops',
	'/network',
	'/search',
	'/metrics',
	'/status',
	'/rankings',
	'/receipt',
	'/alerts',
	'/privacy',
	'/terms',
	'/accessibility',
	'/roadmap',
	'/lines/new',
	'/stop/new',
];
it('keeps each description short and leaves the CTA to the share card', () => {
	for (const locale of ['en', 'fr'] as const)
		for (const path of paths) {
			const seo = resolveRouteSeo(path, locale);
			const copy = shareCopy(path, locale);
			expect(seo.description.length, path).toBeGreaterThanOrEqual(25);
			expect(seo.description.length, path).toBeLessThanOrEqual(110);
			expect(seo.description.endsWith(copy.cta + '.'), path).toBe(false);
			expect(seo.description).not.toContain('—');
		}
});
it('names the discovered provider in its description', () => {
	for (const locale of ['en', 'fr'] as const)
		for (const identity of [
			{ id: 'stm', shortName: 'STM', city: 'Montréal' },
			{ id: 'octranspo', shortName: 'OC Transpo', city: 'Ottawa' },
		]) {
			const seo = resolveRouteSeo('/?provider=' + identity.id, locale, identity);
			expect(seo.description).toContain(identity.shortName);
			expect(seo.description).toContain(identity.city);
			expect(seo.description.length).toBeLessThanOrEqual(110);
			expect(seo.description.endsWith(shareCopy('/', locale).cta + '.')).toBe(false);
		}
});

it('describes a record of service delivered, not a trip planner', () => {
	const planner = /schedule|predicted|route,|horaire|prévus|parcours/iu;
	for (const locale of ['en', 'fr'] as const)
		for (const path of paths) expect(shareCopy(path, locale).support, path).not.toMatch(planner);
	expect(shareCopy('/lines/51', 'en').support).toBe(
		'How on time the line ran and how much of its service was delivered',
	);
	expect(shareCopy('/stop/52847', 'fr').support).toBe(
		'La ponctualité des passages à cet arrêt, jour par jour',
	);
	expect(resolveRouteSeo('/lines/51', 'fr').title).toBe('Bilan de la ligne');
});
