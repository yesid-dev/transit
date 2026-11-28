import type { Locale } from '#lib/i18n/index.ts';
import type { TableHealth } from '#lib/server/engine.ts';
import { choose } from './recordText.ts';

const tables: Record<string, [string, string]> = {
	stop_events: ['Stop arrivals', 'Passages aux arrêts'],
	trip_days: ['Trips run each day', 'Trajets effectués par jour'],
	scheduled_stop_times: ['Timetable', 'Horaire'],
	vehicle_positions: ['Vehicle positions', 'Positions des véhicules'],
	feed_polls: ['Feed checks', 'Vérifications des flux'],
	alerts: ['Service alerts', 'Avis de service'],
	prediction_samples: ['Arrival predictions', 'Prévisions d’arrivée'],
	segment_runs: ['Travel between stops', 'Parcours entre les arrêts'],
};

const states: Record<TableHealth['status'], [string, string]> = {
	present: ['Present', 'Présent'],
	missing: ['Missing', 'Manquant'],
	incomplete: ['Incomplete', 'Incomplet'],
	not_measured: ['Not measured', 'Non mesuré'],
	not_tracked: ['Not tracked', 'Non suivi'],
};

const reasons: Record<string, [string, string]> = {
	no_manifest: ['No file list for that day', 'Aucune liste de fichiers pour ce jour'],
	invalid_manifest: ['File list unreadable', 'Liste de fichiers illisible'],
	file_missing: ['File missing', 'Fichier manquant'],
	size_mismatch: [
		'File size differs from the file list',
		'La taille du fichier diffère de la liste de fichiers',
	],
	no_raw_captures: ['No raw captures', 'Aucune capture brute'],
	no_schedule_edition: ['No schedule edition', 'Aucune édition de l’horaire'],
	schedule_archive_unreadable: ['Schedule archive unreadable', 'Archive de l’horaire illisible'],
};

export function healthReason(reason: string | undefined, locale: Locale) {
	return reason && Object.hasOwn(reasons, reason)
		? choose(locale, ...reasons[reason])
		: choose(locale, 'Reason unknown', 'Raison inconnue');
}

export function tableName(table: string, locale: Locale) {
	return Object.hasOwn(tables, table) ? choose(locale, ...tables[table]) : table;
}

export function healthReading(cell: TableHealth | undefined, locale: Locale, dayReason?: string) {
	if (!cell) return choose(locale, 'Unknown', 'Inconnu');
	const state = choose(locale, ...states[cell.status]);
	const reason = cell.reason ?? dayReason;
	if (!reason) return state;
	const detail = healthReason(reason, locale);
	return `${state} (${detail})`;
}
