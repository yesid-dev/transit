import { expect, it } from 'vitest';
import type { MethodEntry } from '#lib/server/engine.ts';
import { methodCopy } from './methodCatalog.copy.ts';
import { methodGroups } from './methodCatalogText.ts';
import { downloadTables } from './downloadTables.ts';

const plain = (text: string) => text.replace(/[\u00a0\u202f]/gu, ' ');

it.each([
	[
		'en',
		'Not a comparison between cities: each agency’s feed gives its times in its own way, so the figures of two cities are not directly comparable. Each screen says how its times were observed.',
	],
	[
		'fr',
		'Pas une comparaison entre villes : le flux de chaque société de transport donne ses heures à sa manière, donc les chiffres de deux villes ne sont pas directement comparables. Chaque écran indique comment ses heures ont été observées.',
	],
] as const)('says the two cities are not comparable in %s', (locale, sentence) => {
	expect(methodCopy[locale].recordLimits.map(plain)).toContain(sentence);
});

it.each([
	['en', 'About Transit', 'Who publishes it', 'Seen an error?', 'Email contact@yesid.dev'],
	[
		'fr',
		'À propos de Transit',
		'Qui le publie',
		'Vous avez vu une erreur\u00a0?',
		'Écrire à contact@yesid.dev',
	],
] as const)(
	'names the publisher and how to report an error in %s',
	(locale, title, who, error, link) => {
		const { about } = methodCopy[locale];
		expect(about.title).toBe(title);
		expect(about.fields.map(({ label }) => label)).toEqual(expect.arrayContaining([who, error]));
		const report = about.fields.find((field) => field.label === error);
		expect(report && 'link' in report && report.link).toEqual({
			href: 'mailto:contact@yesid.dev',
			label: link,
		});
		const text = about.fields.map((field) => field.text).join(' ');
		expect(text).toContain('Yesid Fernando Otalora');
		expect(text).not.toMatch(/[\u2013\u2014]|\bbus\b|agence/u);
	},
);

const entry = (id: string) => ({ id, family: 'delay' }) as unknown as MethodEntry;

it.each([
	['en', 'Median delay and the latest 1 in 10', /cancellation notice counts as cancelled/u],
	['fr', 'Retard médian et dixième le plus en retard', /avis d’annulation compte comme annulé/u],
] as const)('names the 90th percentile as riders read it in %s', (locale, name, cancelled) => {
	const { groups } = methodGroups(
		[entry('median_delay'), entry('p90_delay'), entry('trips_run')],
		locale,
	);
	expect(groups.find(({ id }) => id === 'delay-percentiles')?.name).toBe(name);
	expect(groups.find(({ id }) => id === 'delay-percentiles')?.summary).not.toMatch(
		/percentile|centile/u,
	);
	expect(groups.find(({ id }) => id === 'trip-delivery')?.summary).toMatch(cancelled);
});

it('says a vehicle file row is a run of identical reports', () => {
	expect(downloadTables.vehicle_positions.en).toMatch(/^One row per run of identical reports/u);
	expect(downloadTables.vehicle_positions.fr).toMatch(
		/^Une ligne par suite de relevés identiques/u,
	);
});
