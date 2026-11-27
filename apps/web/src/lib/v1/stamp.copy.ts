export type LiveState = 'current' | 'behind' | 'not-responding' | 'unknown';

export const stampCopy = {
	en: {
		live: (subject: 'data' | 'alerts', state: LiveState, age: string | null, paused = false) =>
			(paused ? 'Paused' : subject === 'alerts' ? 'Live notices' : 'Live') +
			' · ' +
			(state === 'not-responding'
				? 'not responding'
				: state === 'unknown'
					? 'update time unknown'
					: 'updated ' + age + (state === 'behind' ? ' · not current' : '')),
		record: (date: string | null, published: string | null, scope: 'window' | 'day') =>
			[
				'Record',
				date ? `${scope === 'day' ? 'day of' : 'data through'} ${date}` : null,
				published ? `published ${published}` : null,
			]
				.filter(Boolean)
				.join(' · '),
		warning: 'This record was published with a warning. See Data health.',
		pause: 'Pause live updates',
		pausedStatus: 'Live updates paused.',
		resumedStatus: 'Live updates resumed.',
		switchOn: 'On',
		switchOff: 'Off',
	},
	fr: {
		live: (subject: 'data' | 'alerts', state: LiveState, age: string | null, paused = false) =>
			(paused ? 'En pause' : subject === 'alerts' ? 'Avis en direct' : 'En direct') +
			' · ' +
			(state === 'not-responding'
				? 'ne répond pas'
				: state === 'unknown'
					? 'heure de mise à jour inconnue'
					: 'mis à jour ' + age + (state === 'behind' ? ' · pas à jour' : '')),
		record: (date: string | null, published: string | null, scope: 'window' | 'day') =>
			[
				'Bilan',
				date ? `${scope === 'day' ? 'journée du' : 'données jusqu’au'} ${date}` : null,
				published ? `publié le ${published}` : null,
			]
				.filter(Boolean)
				.join(' · '),
		warning: 'Ce bilan a été publié avec un avertissement. Voir Santé des données.',
		pause: 'Suspendre les mises à jour',
		pausedStatus: 'Mises à jour en direct suspendues.',
		resumedStatus: 'Mises à jour en direct reprises.',
		switchOn: 'Oui',
		switchOff: 'Non',
	},
};
