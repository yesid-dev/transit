import type { Locale } from '#lib/i18n/index.ts';
import type { MethodEntry } from '#lib/server/engine.ts';
import { registryUnitText } from '#lib/site/presenter.ts';
import methodNames from './methodNames.json';

// These display names belong in the engine registry when it supplies localized titles.
const names: Readonly<Partial<Record<string, readonly string[]>>> = methodNames;

const sameAsNames: Readonly<Partial<Record<string, readonly [string, string]>>> = {
	on_time: ['the on-time share', 'la part à l’heure'],
	trips_run: ['trips that ran', 'les trajets effectués'],
};

export const earlyLateDefinitionEn =
	'Early is more than 1 minute ahead of the timetable. Late is more than 5 minutes behind it.';

const familySummaries: Readonly<Partial<Record<string, Record<Locale, string>>>> = {
	service_delivered: {
		en: 'How much of the scheduled service hours ran, and whether the first and last departures of the day ran.',
		fr: 'La part des heures de service prévues qui ont été effectuées, et si le premier et le dernier départ de la journée ont eu lieu.',
	},
	crowding: {
		en: 'How full vehicles reported being, from empty to full, as a share of their reporting time.',
		fr: 'Le niveau d’occupation signalé par les véhicules, de vide à plein, en part de leur temps de signalement.',
	},
	alert_counts: {
		en: 'How many notices the agency published, how often it revised them and how long they stayed in effect.',
		fr: 'Le nombre d’avis publiés par la société de transport, leurs mises à jour et leur durée en vigueur.',
	},
	waiting_and_gaps: {
		en: 'The time between vehicles at a stop when service is frequent: long gaps, vehicles too close together and the extra wait.',
		fr: 'L’intervalle entre deux véhicules à un arrêt quand le service est fréquent\u00a0: intervalles prolongés, véhicules trop rapprochés et attente excédentaire.',
	},
	service_offered: {
		en: 'What the timetable plans: trips, trips per hour, and the evening and weekend periods with fewer than 2 trips an hour.',
		fr: 'Ce que prévoit l’horaire\u00a0: les trajets, les trajets par heure, et les périodes de soir et de fin de semaine à moins de 2 trajets par heure.',
	},
	vehicles: {
		en: 'The on-time, early, late and delay measures, counted for one vehicle.',
		fr: 'Les mesures de ponctualité et de retard, comptées pour un seul véhicule.',
	},
	corridors: {
		en: 'The time vehicles lose between two consecutive stops, against the timetable.',
		fr: 'Le temps que les véhicules perdent entre deux arrêts consécutifs, par rapport à l’horaire.',
	},
	open_data_scorecard: {
		en: 'How the agency’s feeds arrive: captures that succeeded, how fresh and complete they are, and how close the predictions were.',
		fr: 'L’état des flux de la société de transport\u00a0: collectes réussies, fraîcheur, données présentes et justesse des prévisions.',
	},
	accessibility: {
		en: 'The share of trips and of stops the agency declares wheelchair accessible.',
		fr: 'La part des trajets et des arrêts que la société de transport déclare accessibles en fauteuil roulant.',
	},
};

const featured = [
	{
		id: 'on_time',
		name: methodNames.on_time,
		has: (id: string) => id === 'on_time',
	},
	{
		id: 'early-late',
		name: ['Early and late', 'En avance et en retard'],
		summary: [
			earlyLateDefinitionEn,
			'Un passage est en avance s’il a lieu plus d’une minute avant l’heure prévue. Il est en retard s’il a lieu plus de 5 minutes après.',
		],
		has: (id: string) => id === 'early' || id === 'late',
	},
	{
		id: 'trip-delivery',
		name: ['Trips that ran, cancelled and missing', 'Trajets effectués, annulés et manquants'],
		summary: [
			'A scheduled trip ran, was cancelled with a notice from the agency, or is missing: no vehicle was seen and no notice was found. A trip with a cancellation notice counts as cancelled, as the agency said, even when a vehicle was seen at some of its stops.',
			'Un trajet prévu a été effectué, a été annulé avec un avis de la société de transport ou est manquant\u00a0: aucun véhicule n’a été observé et aucun avis n’a été relevé. Un trajet visé par un avis d’annulation compte comme annulé, comme l’a dit la société de transport, même si un véhicule a été vu à certains de ses arrêts.',
		],
		has: (id: string) => ['trips_run', 'cancelled_trips', 'missing_trips'].includes(id),
	},
	{
		id: 'delay-percentiles',
		name: ['Median delay and the latest 1 in 10', 'Retard médian et dixième le plus en retard'],
		summary: [
			'About half of observed stop events were at or below the median delay. The latest 1 in 10 is the delay that about nine in ten stayed at or below.',
			'Environ la moitié des passages observés avaient un retard inférieur ou égal à la médiane. Le dixième le plus en retard est le retard que neuf passages sur dix environ n’ont pas dépassé.',
		],
		has: (id: string) => id === 'median_delay' || id === 'p90_delay',
	},
	{
		id: 'vehicle-measures',
		name: [
			'Vehicles: in service, stopped reporting, trips not finished',
			'Véhicules\u00a0: en service, interruptions du signal et trajets non terminés',
		],
		summary: [
			'A vehicle is in service on a day when it reported at least once while on a scheduled trip.',
			'Un véhicule est en service s’il a transmis au moins un relevé pendant un trajet prévu ce jour-là.',
		],
		has: (id: string) =>
			id.startsWith('vehicle_') &&
			![
				'vehicle_early',
				'vehicle_on_time',
				'vehicle_late',
				'vehicle_median_delay',
				'vehicle_p90_delay',
				'vehicle_field_completeness',
			].includes(id),
	},
];

export type MethodGroup = {
	id: string;
	name: string;
	summary?: string;
	entries: MethodEntry[];
};

export function methodGroups(entries: MethodEntry[], locale: Locale) {
	const index = locale === 'en' ? 0 : 1;
	const groups: MethodGroup[] = featured.flatMap(({ id, name, summary, has }) => {
		const matching = entries.filter((entry) => has(entry.id));
		return matching.length
			? [{ id, name: name[index], summary: summary?.[index], entries: matching }]
			: [];
	});
	const used = new Set(groups.flatMap((group) => group.entries.map((entry) => entry.id)));
	const extra: MethodGroup[] = Object.entries(
		Object.groupBy(
			entries.filter(({ id }) => !used.has(id)),
			({ family }) => family,
		),
	).map(([id, members = []]) => ({
		id: 'family-' + id,
		name: members[0].family_text?.[locale] ?? id,
		summary: familySummaries[id]?.[locale],
		entries: members,
	}));
	return { groups, extra };
}

export function methodName(entry: MethodEntry, locale: Locale) {
	return (
		names[entry.id]?.[locale === 'en' ? 0 : 1] ?? methodSummary(entry, locale).replace(/\.$/u, '')
	);
}

export function sameAsName(entry: MethodEntry, locale: Locale) {
	return sameAsNames[entry.id]?.[locale === 'en' ? 0 : 1] ?? methodName(entry, locale);
}

export const proseFields = ['counts', 'exclusions', 'limits'] as const;
export type ProseField = (typeof proseFields)[number];

export type FieldPart = {
	field: ProseField;
	lead: string | undefined;
	shared: string[];
};

export type MeasureView = {
	entry: MethodEntry;
	summary: string;
	parts: FieldPart[];
	minimumSample: number | null;
	rankingMinimumSample: number | null;
	since: string | null;
};

export const dataUserFields = ['calculation', 'ordering', 'caveat'] as const;
export type DataUserField = (typeof dataUserFields)[number];

const dataUserField: Record<ProseField, DataUserField> = {
	counts: 'calculation',
	exclusions: 'caveat',
	limits: 'caveat',
};

export type DataUserNote = {
	label?: string;
	field: DataUserField;
	text: string;
};

export type GroupView = {
	group: MethodGroup;
	measures: MeasureView[];
	sharedParts: FieldPart[];
	sharedMinimumSample: number | null;
	sharedRankingMinimumSample: number | null;
	sharedSince: string | null;
	dataUsers: DataUserNote[];
};

function sentences(text: string, locale: Locale) {
	return Array.from(
		new Intl.Segmenter(locale, { granularity: 'sentence' }).segment(text),
		({ segment }) => segment.trim(),
	).filter(Boolean);
}

export function methodSummary(entry: MethodEntry, locale: Locale) {
	return registryUnitText(sentences(entry.text[locale].definition, locale)[0] ?? '', locale);
}

function partKey(part: FieldPart) {
	return JSON.stringify([part.lead ?? '', part.shared]);
}

function nonEmptyPart(part: FieldPart) {
	return Boolean(part.lead) || part.shared.length > 0;
}

function commonValue<T>(values: readonly T[]): T | null {
	if (!values.length) return null;
	const first = values[0];
	return values.every((value) => value === first) ? first : null;
}

/**
 * Structure each family card so the first level gives one plain sentence per measure
 * and shared family rules once, while technical details sit in one "For data users" note.
 */
export function buildMethodViews(groups: readonly MethodGroup[], locale: Locale): GroupView[] {
	const firstLeadOwner = new Map<string, string>();
	const firstNoteOwner = new Map<string, string>();

	return groups.map((group) => {
		const groupIds = new Set(group.entries.map((entry) => entry.id));
		const rawMeasures = group.entries.map((entry) => {
			const source = entry.text[locale];
			const defSentences = sentences(registryUnitText(source.definition, locale), locale);
			const summary = defSentences[0] ?? '';
			const defDetails = defSentences.slice(1);
			const histogramSentences = source.histogram
				? sentences(registryUnitText(source.histogram, locale), locale)
				: [];

			const parts: FieldPart[] = [];
			const fieldNotes: { field: ProseField; text: string }[] = [];

			for (const field of proseFields) {
				const fieldSentences = sentences(registryUnitText(source[field], locale), locale);
				const leadSentence = fieldSentences[0];
				const detailSentences = [
					...fieldSentences.slice(1),
					...(field === 'counts' ? histogramSentences : []),
				];

				let lead: string | undefined;
				const shared: string[] = [];
				if (leadSentence) {
					const key = JSON.stringify([entry.family, field, leadSentence]);
					const owner = firstLeadOwner.get(key);
					if (owner && !groupIds.has(owner)) {
						shared.push(owner);
					} else {
						if (!owner) firstLeadOwner.set(key, entry.id);
						lead = leadSentence;
					}
				}
				parts.push({ field, lead, shared });

				const uniqueDetails: string[] = [];
				for (const sentence of detailSentences) {
					const key = JSON.stringify([entry.family, field, sentence]);
					const owner = firstNoteOwner.get(key);
					if (!owner) {
						firstNoteOwner.set(key, entry.id);
						uniqueDetails.push(sentence);
					}
				}
				if (uniqueDetails.length) {
					fieldNotes.push({ field, text: uniqueDetails.join(' ') });
				}
			}

			const uniqueDefDetails: string[] = [];
			for (const sentence of defDetails) {
				const key = JSON.stringify([entry.family, 'definition', sentence]);
				if (!firstNoteOwner.has(key)) {
					firstNoteOwner.set(key, entry.id);
					uniqueDefDetails.push(sentence);
				}
			}

			return {
				entry,
				summary,
				parts,
				defNotes: uniqueDefDetails.join(' '),
				fieldNotes,
			};
		});

		const isMulti = group.entries.length > 1;
		const sharedParts: FieldPart[] = [];
		const liftedByField = new Map<ProseField, string>();

		if (isMulti) {
			for (const field of proseFields) {
				const fieldParts = rawMeasures.map((m) => m.parts.find((p) => p.field === field)!);
				const freq = new Map<string, { count: number; part: FieldPart }>();
				for (const part of fieldParts) {
					const key = partKey(part);
					const existing = freq.get(key);
					if (existing) existing.count += 1;
					else freq.set(key, { count: 1, part });
				}
				let best: { key: string; count: number; part: FieldPart } | null = null;
				for (const [key, item] of freq) {
					if (item.count >= 2 && (!best || item.count > best.count)) {
						best = { key, ...item };
					}
				}
				if (best && (best.part.lead || best.part.shared.length > 0)) {
					sharedParts.push(best.part);
					liftedByField.set(field, best.key);
				}
			}
		}

		const allMin = group.entries.map((e) => (e.minimum_sample > 0 ? e.minimum_sample : null));
		const sharedMinimumSample = isMulti ? commonValue(allMin) : null;
		const allRankMin = group.entries.map((e) => e.ranking_minimum_sample ?? null);
		const sharedRankingMinimumSample = isMulti ? commonValue(allRankMin) : null;
		const allSince = group.entries.map((e) => e.since || null);
		const sharedSince = isMulti ? commonValue(allSince) : null;

		const measures: MeasureView[] = rawMeasures.map((m) => {
			const minSample =
				m.entry.minimum_sample > 0 && m.entry.minimum_sample !== sharedMinimumSample
					? m.entry.minimum_sample
					: null;
			const rankMin =
				m.entry.ranking_minimum_sample &&
				m.entry.ranking_minimum_sample !== sharedRankingMinimumSample
					? m.entry.ranking_minimum_sample
					: null;
			const since = m.entry.since && m.entry.since !== sharedSince ? m.entry.since : null;
			const parts = m.parts.filter((part) => {
				if (isMulti && liftedByField.get(part.field) === partKey(part)) return false;
				return nonEmptyPart(part);
			});
			return {
				entry: m.entry,
				summary: m.summary,
				parts,
				minimumSample: minSample,
				rankingMinimumSample: rankMin,
				since,
			};
		});

		const dataUsers: DataUserNote[] = [];
		const distinctDefs = rawMeasures.filter((m) => m.defNotes);
		for (const m of distinctDefs) {
			dataUsers.push({
				label: isMulti ? methodName(m.entry, locale) : undefined,
				field: 'calculation',
				text: m.defNotes,
			});
		}

		for (const field of proseFields) {
			const matching = rawMeasures
				.map((m) => ({ entry: m.entry, note: m.fieldNotes.find((n) => n.field === field)?.text }))
				.filter((item): item is { entry: MethodEntry; note: string } => Boolean(item.note));
			if (matching.length === 1) {
				const [{ entry, note }] = matching;
				const label = isMulti && !liftedByField.has(field) ? methodName(entry, locale) : undefined;
				dataUsers.push({ field: dataUserField[field], label, text: note });
			} else if (matching.length > 1) {
				for (const { entry, note } of matching) {
					dataUsers.push({
						field: dataUserField[field],
						label: methodName(entry, locale),
						text: note,
					});
				}
			}
		}

		return {
			group,
			measures,
			sharedParts,
			sharedMinimumSample,
			sharedRankingMinimumSample,
			sharedSince,
			dataUsers,
		};
	});
}
