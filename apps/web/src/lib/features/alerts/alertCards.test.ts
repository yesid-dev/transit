import { expect, it } from 'vitest';
import { agencyMessage } from '#lib/site/agencyMessages.ts';
import { noPublishedNotices, noticeLineName, noticesForLines } from '#lib/site/presenter.ts';
import { groupAlertCards, recordAlertCards, sortAlertLineCut } from './alertCards';

it('groups the same bilingual roadworks notice across lines and retains its published IDs', () => {
	const period = { start: '2026-11-24T17:00:00Z', end: '2026-11-28T04:59:00Z' };
	const message = {
		source: 'fixture',
		version: '1',
		stops: ['52997'],
		header: { en: 'Your stop', fr: 'Votre arrêt' },
		description: {
			en: 'This stop is cancelled due to roadworks, from November 24 2026 at 12h00 until November 27 2026 at 23h59.',
			fr: 'Cet arrêt est annulé en raison de travaux, du 24 novembre 2026 à 12h00 au 27 novembre 2026 à 23h59.',
		},
		periods: [period],
	};
	const cards = recordAlertCards([
		{ ...message, id: 'roadworks-34', routes: ['34'], reissue_ids: ['roadworks-34-fr'] },
		{ ...message, id: 'roadworks-125', routes: ['125'] },
		{
			...message,
			id: 'roadworks-125-reissue',
			routes: ['125'],
			description: {
				...message.description,
				en: ` <p>${message.description.en.replace('due to', 'due&nbsp; to').slice(0, -1)}</p> `,
			},
		},
		{ ...message, id: 'roadworks-353', routes: ['353'] },
		{
			...message,
			id: 'roadworks-353-later',
			routes: ['353'],
			periods: [{ ...period, end: '2026-11-29T04:59:00Z' }],
		},
		{
			...message,
			id: 'roadworks-different-french',
			routes: ['353'],
			description: { ...message.description, fr: 'Cet arrêt est déplacé en raison de travaux.' },
		},
	]);
	const grouped = groupAlertCards(cards);
	expect(grouped.map(({ ids, routes }) => ({ ids, routes }))).toEqual([
		{
			ids: [
				'roadworks-34',
				'roadworks-34-fr',
				'roadworks-125',
				'roadworks-125-reissue',
				'roadworks-353',
			],
			routes: ['34', '125', '353'],
		},
		{ ids: ['roadworks-353-later'], routes: ['353'] },
		{ ids: ['roadworks-different-french'], routes: ['353'] },
	]);
});

it.each([
	[
		'en',
		'Stop Sherbrooke / Davidson is closed.',
		'STM published no notice for this stop on these dates.',
		'Notices for line 361',
	],
	[
		'fr',
		'L’arrêt Sherbrooke / Davidson est fermé.',
		'La STM n’a publié aucun avis pour cet arrêt à ces dates.',
		'Avis pour la ligne 361',
	],
] as const)(
	'names the stop and presents an honest empty period in %s',
	(locale, message, empty, related) => {
		const notice = {
			routes: ['361'],
			header: { en: 'Your stop', fr: 'Votre arrêt' },
			description: { en: 'This stop is closed.', fr: 'Cet arrêt est fermé.' },
		};
		expect(agencyMessage(notice, locale, ['52997'], () => 'Sherbrooke / Davidson').title.text).toBe(
			message,
		);
		expect(noPublishedNotices({ name: 'STM', frenchOf: 'de la STM' }, 'stop', locale)).toBe(empty);
		expect(noticesForLines(['361'], locale)).toBe(related);
	},
);

it('uses a published route number once even when the line name starts with it', () => {
	expect(noticeLineName('37', '37 · Jolicoeur')).toBe('Jolicoeur');
	expect(noticeLineName('37', '37 / 37 · Jolicoeur')).toBe('Jolicoeur');
	expect(noticeLineName('3', '37 · Jolicoeur')).toBe('37 · Jolicoeur');
	expect(noticeLineName('37', '37')).toBeNull();
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
