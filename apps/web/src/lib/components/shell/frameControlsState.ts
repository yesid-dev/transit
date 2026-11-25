import { delocalizePath, type Locale } from '#lib/i18n/index.ts';
import { isRankingPath } from '#lib/features/rankings/rankingSelection.ts';
import { lineFrameView } from '#lib/site/lineFrame.ts';
import { stopFrameView } from '#lib/site/stopFrame.ts';
import { networkRecordView } from '#lib/site/networkFrame.ts';
import { dateRange } from '#lib/site/presenter.ts';
import {
	parseFrameState,
	unpublishedYesterday,
	type FrameClock,
	type Preset,
} from '#lib/site/frameState.ts';

export const frameCopy = {
	en: {
		controls: 'Controls',
		open: 'Open controls',
		close: 'Close controls',
		view: 'View',
		live: 'Live now',
		record: 'Record',
		viewHint: {
			live: 'What the feeds say at this moment.',
			record: 'What was delivered over the dates below.',
		},
		recordOnly: 'This screen is a record. It has no live view.',
		liveOnly: 'This screen shows the trip in progress.',
		recordDates: 'Dates apply to Record',
		liveMoment: 'Live now shows this moment only.',
		period: 'Period',
		waitingForMonth: 'This month’s first complete day is not in the record yet.',
		waitingForDay: (date: string) =>
			`${date} is not in the record yet. Each day is added the next day, after cleaning.`,
		presets: {
			yesterday: 'Yesterday',
			'7-days': '7 days',
			'28-days': '28 days',
			'this-month': 'This month',
			'last-month': 'Last month',
			'12-months': '12 months',
		},
		title7: 'Last 7 complete days',
		custom: 'Choose other dates',
		from: 'From',
		to: 'To',
		apply: 'Show these dates',
		note: (date: string) => `Record starts ${date}.`,
		dayCount: (days: number) => `${days} ${days === 1 ? 'day' : 'days'}`,
		missing: 'Enter both dates.',
		bounds: 'Choose dates between the start of the record and today.',
		completeBounds: 'Choose dates between the start of the record and yesterday.',
		order: 'The end date must be on or after the start date.',
		tooLong: (days: number) => `Choose a period of at most ${days} days.`,
	},
	fr: {
		controls: 'Commandes',
		open: 'Ouvrir les commandes',
		close: 'Fermer les commandes',
		view: 'Vue',
		live: 'En direct',
		record: 'Bilan',
		viewHint: {
			live: 'Ce que disent les flux en ce moment.',
			record: 'Ce qui a été livré aux dates ci-dessous.',
		},
		recordOnly: 'Cet écran présente un bilan. Il n’a pas de vue en direct.',
		liveOnly: 'Cet écran montre le trajet en cours.',
		recordDates: 'Les dates s’appliquent au bilan',
		liveMoment: 'La vue en direct montre seulement la situation actuelle.',
		period: 'Période',
		waitingForMonth: 'Le premier jour complet de ce mois-ci ne figure pas encore au bilan.',
		waitingForDay: (date: string) =>
			`La journée du ${date} ne figure pas encore au bilan. Chaque journée est ajoutée le lendemain, après le nettoyage des données.`,
		presets: {
			yesterday: 'Hier',
			'7-days': '7 jours',
			'28-days': '28 jours',
			'this-month': 'Ce mois-ci',
			'last-month': 'Le mois dernier',
			'12-months': '12 mois',
		},
		title7: '7 derniers jours complets',
		custom: 'Choisir d’autres dates',
		from: 'Du',
		to: 'Au',
		apply: 'Afficher ces dates',
		note: (date: string) => `Le bilan commence le ${date}.`,
		dayCount: (days: number) => `${days} ${days === 1 ? 'jour' : 'jours'}`,
		missing: 'Entrez les deux dates.',
		bounds: 'Choisissez des dates entre le début du bilan et aujourd’hui.',
		completeBounds: 'Choisissez des dates entre le début du bilan et hier.',
		order: 'La date de fin doit être égale ou postérieure à la date de début.',
		tooLong: (days: number) => `Choisissez une période d’au plus ${days} jours.`,
	},
} satisfies Record<Locale, { presets: Record<Preset, string>; [key: string]: unknown }>;

export function frameControlsState(url: URL, clock: FrameClock) {
	const path = delocalizePath(url.pathname).replace(/\/$/, '') || '/';
	const recordOnly =
		isRankingPath(path) || ['/lines', '/stops', '/receipt', '/download'].includes(path);
	const line = /^\/lines\/[^/]+$/.test(path);
	const stop = /^\/stop\/[^/]+$/.test(path);
	const map = path === '/map';
	const liveOnly = path.startsWith('/trip/');
	const parsed = parseFrameState(
		url.searchParams,
		path === '/status' ? { ...clock, recordThrough: null } : clock,
	);
	let mode = parsed.mode;
	if (recordOnly) mode = 'record';
	else if (liveOnly) mode = 'live';
	else if (line) mode = lineFrameView(url) === 'live' ? 'live' : 'record';
	else if (stop) mode = stopFrameView(url);
	else if (map)
		mode = ['stops', 'corridors'].includes(url.searchParams.get('mapLayer') ?? '')
			? 'record'
			: 'live';
	else if (path === '/network') mode = networkRecordView(url) ? 'record' : 'live';
	return {
		...parsed,
		mode,
		showRail: !['/roadmap', '/privacy', '/terms', '/accessibility'].includes(path),
		showViewHint:
			['/', '/network', '/status', '/metrics'].includes(path) ||
			path.startsWith('/departure/') ||
			(mode === 'record' && path.startsWith('/vehicle/')),
		recordOnly,
		liveOnly,
		detail: line || stop,
		map,
		waitingForYesterday:
			mode === 'record' && path !== '/download' && path !== '/status'
				? unpublishedYesterday(parsed.period, clock)
				: null,
		usesFrameRecord:
			recordOnly ||
			line ||
			stop ||
			path.startsWith('/departure/') ||
			['/', '/alerts', '/network', '/status', '/vehicles'].includes(path) ||
			path.startsWith('/vehicle/'),
	} as const;
}

export function framePeriodSummary(
	period: ReturnType<typeof parseFrameState>['period'],
	locale: Locale,
) {
	if (!period) return null;
	const copy = frameCopy[locale];
	const days = (Date.parse(period.to) - Date.parse(period.from)) / 86_400_000 + 1;
	return {
		title:
			period.preset === '7-days' ? copy.title7 : period.preset ? copy.presets[period.preset] : null,
		dates: dateRange(period, locale),
		duration: copy.dayCount(days),
	};
}
