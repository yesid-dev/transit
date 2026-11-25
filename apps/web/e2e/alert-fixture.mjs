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
			url: {},
			cause: 'CONSTRUCTION',
			effect: effects[index % effects.length],
			severity: null,
			routes: index === 2 ? lines : [lines[line]],
			stops: index % 4 === 0 ? ['51234'] : [],
		};
	});
}
