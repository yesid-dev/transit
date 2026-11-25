import { expect, it } from 'vitest';
import {
	agencyMessage,
	agencyMessageLink,
	agencyMessagePeriods,
	sortAgencyMessages,
	type AgencyMessage,
} from './agencyMessages';

type TestMessage = AgencyMessage & { id: string };

const card: TestMessage = {
	id: 'fixture',
	routes: ['24'],
	header: { fr: 'Votre arrêt' },
	description: {
		fr: '<p><strong>Votre arrêt</strong></p><p>Suivez la <a href="https://example.com/avis">signalisation</a>.<br>Prévoyez plus de temps.</p>',
	},
	periods: [],
};

it('keeps agency section breaks and labels the source language on a fallback', () => {
	expect(agencyMessage(card, 'en')).toEqual({
		title: { text: 'Suivez la signalisation.', lang: 'fr' },
		body: { text: 'Prévoyez plus de temps.', lang: 'fr' },
	});
});

it('prefers a published heading from either language, and removes it when the body repeats it', () => {
	expect(
		agencyMessage(
			{
				...card,
				header: { en: 'Your stop', fr: 'Travaux sur Beaubien' },
				description: { fr: 'Travaux sur Beaubien. Utilisez l’arrêt temporaire.' },
			},
			'en',
		),
	).toEqual({
		title: { text: 'Travaux sur Beaubien', lang: 'fr' },
		body: { text: 'Utilisez l’arrêt temporaire.', lang: 'fr' },
	});
	expect(agencyMessage({ ...card, description: {} }, 'en')).toEqual({
		title: { text: 'Message without text', lang: 'en' },
		body: null,
	});
});

it('orders by publication start, natural line number and agency text independently of alert IDs', () => {
	const sample = (id: string, line: string, text: string, start: string): TestMessage => ({
		...card,
		id,
		routes: [line],
		header: {},
		description: { en: text },
		periods: [{ start, end: null }],
	});
	const day = '2026-11-17T05:00:00Z';
	const cards = [
		sample('a', '10', 'Detour', day),
		sample('b', '2', 'Stop moved', day),
		sample('c', '2', 'Detour', day),
		sample('d', '80', 'Detour', '2026-11-18T05:00:00Z'),
	];
	expect(sortAgencyMessages(cards, 'en', (line) => line).map(({ id }) => id)).toEqual([
		'd',
		'c',
		'b',
		'a',
	]);
});

it('retains the agency link embedded in the selected message', () => {
	expect(agencyMessageLink(card, 'en')).toEqual({
		href: 'https://example.com/avis',
		lang: 'fr',
	});
});

it('unions overlapping archive periods and gaps under ten minutes in local time', () => {
	const ranges = [
		{ start: '2026-11-17T05:00:00Z', end: '2026-11-18T04:57:00Z' },
		{ start: '2026-11-17T05:00:00Z', end: '2026-11-19T04:58:00Z' },
		{ start: '2026-11-19T05:05:00Z', end: '2026-11-24T05:00:00Z' },
		{ start: '2026-11-24T05:10:00Z', end: '2026-11-24T08:30:00Z' },
	];
	expect(agencyMessagePeriods(ranges, 'en', 'America/Toronto', false)).toEqual([
		'17 to 23 Nov 2026',
		'24 Nov 2026, 00:10 to 03:30',
	]);
	expect(agencyMessagePeriods(ranges.slice(0, 3), 'fr', 'America/Toronto', false)).toEqual([
		'du 17 au 23 nov. 2026',
	]);
	expect(agencyMessagePeriods(ranges.slice(-1), 'en', 'America/Toronto', true)).toEqual([
		'Since 24 Nov 2026, 00:10.',
		'Until 24 Nov 2026, 03:30.',
	]);
});

it.each(['en', 'fr'] as const)(
	'uses the agency’s first sentence for a generic %s heading',
	(locale) => {
		expect(
			agencyMessage(
				{
					routes: [],
					header: { en: 'Your line', fr: 'Votre arrêt :' },
					description: { en: null, fr: 'Travaux près du terminus. Consultez l’avis complet.' },
				},
				locale,
			),
		).toEqual({
			title: { text: 'Travaux près du terminus.', lang: 'fr' },
			body: { text: 'Consultez l’avis complet.', lang: 'fr' },
		});
	},
);

it.each([
	['en', ['17 to 23 Nov 2026', '25 Nov 2026, 05:00 to 12:00']],
	['fr', ['du 17 au 23 nov. 2026', '25 nov. 2026, de 05:00 à 12:00']],
] as const)('combines overlapping local calendar dates in %s', (locale, label) => {
	expect(
		agencyMessagePeriods(
			[
				{ start: '2026-11-20T10:00:00Z', end: '2026-11-24T05:00:00Z' },
				{ start: '2026-11-25T10:00:00Z', end: '2026-11-25T17:00:00Z' },
				{ start: '2026-11-17T10:00:00Z', end: '2026-11-20T23:00:00Z' },
			],
			locale,
			'America/Toronto',
			false,
		),
	).toEqual(label);
});

it.each([
	['en', 'Since 20 Nov 2026, 09:00.'],
	['fr', 'Depuis le 20 nov. 2026, 09:00.'],
] as const)('uses day-first dates for open live periods in %s', (locale, since) => {
	expect(
		agencyMessagePeriods(
			[{ start: '2026-11-20T14:00:00Z', end: null }],
			locale,
			'America/Toronto',
			true,
		),
	).toEqual([since]);
});
