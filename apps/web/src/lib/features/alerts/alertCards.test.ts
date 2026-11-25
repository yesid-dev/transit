import { expect, it } from 'vitest';
import {
	agencyMessage,
	alertAgencyLink,
	sortAlertCards,
	sortAlertLineCut,
	type AlertCard,
} from './alertCards';

const card: AlertCard = {
	key: 'fixture',
	id: 'fixture',
	routes: ['24'],
	stops: [],
	header: { fr: 'Votre arrêt' },
	description: {
		fr: '<p><strong>Votre arrêt</strong></p><p>Suivez la <a href="https://example.com/avis">signalisation</a>.<br>Prévoyez plus de temps.</p>',
	},
	effect: 'STOP_MOVED',
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
		title: undefined,
		body: null,
	});
});

it('orders by publication start, natural line number and agency text independently of alert IDs', () => {
	const sample = (id: string, line: string, text: string, start: string): AlertCard => ({
		...card,
		id,
		key: id,
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
	expect(sortAlertCards(cards, 'en', (line) => line).map(({ id }) => id)).toEqual([
		'd',
		'c',
		'b',
		'a',
	]);
});

it('retains the agency link embedded in the selected message', () => {
	expect(alertAgencyLink(card, 'en')).toEqual({
		href: 'https://example.com/avis',
		lang: 'fr',
	});
});

it('ranks line counts before natural published line numbers and keeps unavailable values last', () => {
	const numbers: Record<string, string> = {
		'route-10': '10',
		'route-2': '2',
		'route-1': '1',
		'route-80': '80',
		'route-24': '24',
	};
	const rows = [
		{ key: 'route-10', value: 11 },
		{ key: 'route-2', value: 11 },
		{ key: 'route-1', value: 10 },
		{ key: 'route-80', value: 12 },
		{ key: 'route-24', value: null },
	];
	expect(sortAlertLineCut(rows, 'fr', (id) => numbers[id]).map(({ key }) => key)).toEqual([
		'route-80',
		'route-2',
		'route-10',
		'route-1',
		'route-24',
	]);
});
