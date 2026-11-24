import { defineCopy } from '#lib/i18n/copy.ts';

export const presenterCopy = defineCopy({
	en: {
		minutes: (value: string) => `${value} min`,
		unknownTime: 'Unknown time',
		nextDay: (clock: string) => `${clock}, next day`,
		laterDay: (clock: string, days: number) => `${clock}, ${days} days later`,
		early: (value: string) => `${value} early`,
		late: (value: string) => `${value} late`,
		onSchedule: 'On schedule',
		unknownDirection: 'Unknown direction',
		toward: (name: string) => `Toward ${name}`,
		dateRange: (from: string, to: string) => `${from} to ${to}`,
		method: (version: string) => `Method ${version}`,
		cleaning: (versions: string) => `cleaning ${versions}`,
		unknownVersion: 'unknown',
		registryUnitText: (text: string) =>
			text
				.replace(/\b60 seconds early\b/g, '1 minute early')
				.replace(/\b300 seconds late\b/g, '5 minutes late')
				.replace(/\bseconds?\b/gi, 's'),
		tripsInHours: (trips: string, hours: string) => `${trips} trips in ${hours} hours`,
	},
	fr: {
		minutes: (value: string) => `${value} min`,
		unknownTime: 'Heure inconnue',
		nextDay: (clock: string) => `${clock}, le lendemain`,
		laterDay: (clock: string, days: number) => `${clock}, ${days} jours plus tard`,
		early: (value: string) => `${value} d’avance`,
		late: (value: string) => `${value} de retard`,
		onSchedule: 'À l’heure prévue',
		unknownDirection: 'Direction inconnue',
		toward: (name: string) => `Vers ${name}`,
		dateRange: (from: string, to: string) => `du ${from} au ${to}`,
		method: (version: string) => `Méthode ${version}`,
		cleaning: (versions: string) => `nettoyage ${versions}`,
		unknownVersion: 'inconnu',
		registryUnitText: (text: string) =>
			text
				.replace(/\b60 secondes d[’']avance\b/g, '1 minute d’avance')
				.replace(/\b300 secondes de retard\b/g, '5 minutes de retard')
				.replace(/\bsecondes?\b/gi, 's'),
		tripsInHours: (trips: string, hours: string) => `${trips} trajets en ${hours} heures`,
	},
});
