import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const alertLines = JSON.parse(readFileSync(new URL('./alert-lines.json', import.meta.url)));
const firstPageLines = ['24', '18', '55', '80', '45', '97', '69', '161', '165', '211', '10', '51']
	.map((id) => alertLines.find((line) => line.id === id))
	.filter(Boolean);
const extraPageLines = alertLines.filter(
	({ id }) => !firstPageLines.some((line) => line.id === id),
);
const displayLines = [...firstPageLines, ...extraPageLines];

export function stmAlertId(index) {
	return 'anonymous:' + createHash('sha256').update(String(index)).digest('hex').slice(0, 28);
}

export function stmAlertFixtures(total) {
	return Array.from({ length: total }, (_, index) => {
		const { id, long } = displayLines[index % displayLines.length];
		const noText = index === 4;
		const longStops = index === 1;
		const manyLines = index === 2;
		const stops = longStops
			? ['51234', '51236', '51238', '51240', '51242', '51244', '51246', '51248', '51250', '51252']
			: index % 8 === 0
				? ['51234']
				: [];
		return {
			id: stmAlertId(index),
			header: stops.length
				? { en: 'Your stop', fr: 'Votre arrêt' }
				: { en: 'Your line', fr: 'Votre ligne' },
			description: noText
				? {}
				: index === 0
					? { en: 'Use stop 51234. Please allow extra time to reach the temporary stop.' }
					: longStops
						? {
								fr: 'Travaux sur la chaussée de la rue Beaubien.\nLes arrêts suivants sont déplacés pendant les travaux :\nBeaubien / Saint-Denis, vers l’est\nBeaubien / Christophe-Colomb, vers l’ouest\nBeaubien / Saint-Hubert, dans les deux directions\nPour poursuivre votre trajet, utilisez l’arrêt temporaire indiqué à l’intersection suivante.',
							}
						: {
								fr: `Détour sur ${long}. Prévoyez plus de temps pour votre trajet et suivez la signalisation aux arrêts.`,
							},
			url: {},
			cause: null,
			effect: null,
			severity: null,
			routes: manyLines
				? [
						id,
						...displayLines
							.filter((line) => line.id !== id)
							.slice(0, 9)
							.map((line) => line.id),
					]
				: [id],
			stops,
		};
	});
}

export function stmLiveAlertFixtures(time) {
	return stmAlertFixtures(448).map((alert, index) => ({
		...alert,
		periods: [
			[
				new Date(time - (index + 1) * 86_400_000).toISOString(),
				index % 3 === 0 ? '2026-12-31T18:30:00-05:00' : null,
			],
		],
	}));
}

const lines = ['24', '18', '55', '80', '45', '97', '69', '161', '165', '211'];
const names = [
	'Sherbrooke',
	'Beaubien',
	'Saint-Laurent',
	'du Parc',
	'Papineau',
	'du Mont-Royal',
	'Gouin',
	'Van Horne',
	'Côte-des-Neiges',
	'Bord-du-Lac',
];
const effects = ['DETOUR', 'SIGNIFICANT_DELAYS', 'REDUCED_SERVICE', 'STOP_MOVED'];

export function alertFixtures(total) {
	return Array.from({ length: total }, (_, index) => {
		const line = index % lines.length;
		return {
			id: 'a' + (index + 1),
			header: {
				en: index % 4 === 0 ? 'Detour on ' + names[line] : 'Service change on ' + names[line],
				fr: index % 4 === 0 ? 'Détour sur ' + names[line] : 'Service modifié sur ' + names[line],
			},
			description:
				index === 0
					? { en: 'Use stop 51234.' }
					: index === 1
						? {
								fr: 'Votre arrêt\nEn raison de travaux sur la chaussée, l’arrêt est déplacé à l’intersection suivante. Pour poursuivre votre trajet vers le centre-ville, utilisez l’arrêt temporaire situé de l’autre côté de la rue. Le parcours habituel reprendra après la fin des travaux.',
							}
						: {
								en: 'Allow more time for your trip.',
								fr: 'Prévoyez plus de temps pour votre trajet.',
							},
			url:
				index === 0
					? {
							en: 'https://www.stm.info/en/info/service-updates',
							fr: 'https://www.stm.info/fr/infos/etat-du-service',
						}
					: {},
			cause: 'CONSTRUCTION',
			effect: index === 1 ? null : effects[index % effects.length],
			severity: null,
			routes: index === 2 ? lines : [lines[line]],
			stops: index % 4 === 0 ? ['51234'] : [],
		};
	});
}
