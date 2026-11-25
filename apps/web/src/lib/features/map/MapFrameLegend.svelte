<script lang="ts">
	import { createRawSnippet } from 'svelte';
	import { RoutePlate } from '@yesid/ui/brand';
	import { MapLegend, type MapLegendItem, type MapLegendProps } from '@yesid/ui/map';
	import { theme } from '@yesid/ui/state';
	import {
		OCCUPANCY_GLYPH,
		STATUS_GLYPH,
		occupancyVar,
		statusVar,
	} from '#lib/components/dataviz/tokens.ts';
	import type { Locale } from '#lib/i18n/index.ts';
	import { ON_TIME_LIMITS_S } from '#lib/v1/live/statusBands.ts';
	import { mapLegend, type LegendColourBy, type LegendMark } from './mapLegend';
	import { copy } from './map.copy';
	import { recordColours, type RecordMapLayer } from './recordMap';

	let {
		locale,
		layer,
		colourBy,
		staleCutoffS,
		collapsible = false,
		railName,
	}: {
		locale: Locale;
		layer: RecordMapLayer;
		colourBy: LegendColourBy;
		staleCutoffS: number;
		collapsible?: boolean;
		railName?: string;
	} = $props();

	const tr = (en: string, fr: string) => (locale === 'fr' ? fr : en);
	const live = $derived(mapLegend(locale, { colourBy, staleCutoffS }));
	const early = -ON_TIME_LIMITS_S.from / 60;
	const late = ON_TIME_LIMITS_S.through / 60;
	const detail = $derived({
		early: tr(
			`more than ${early} minute ahead of the timetable`,
			`plus de ${early} minute d’avance sur l’horaire`,
		),
		on_time: tr(
			`between ${early} minute early and ${late} minutes late`,
			`entre ${early} minute d’avance et ${late} minutes de retard`,
		),
		late: tr(
			`more than ${late} minutes behind the timetable`,
			`plus de ${late} minutes de retard sur l’horaire`,
		),
		unknown: tr(
			'reporting, with no trip to compare it with',
			'un signalement sans trajet de référence',
		),
	});

	function symbol(mark: LegendMark) {
		if (mark.kind === 'status' || mark.kind === 'occupancy') {
			const ink = mark.kind === 'status' ? statusVar(mark.code) : occupancyVar(mark.code);
			const badge = mark.kind === 'status' ? STATUS_GLYPH[mark.code] : OCCUPANCY_GLYPH[mark.code];
			return createRawSnippet(() => ({
				render: () =>
					`<span class="inline-flex items-center gap-1" style="color:${ink}"><svg width="12" height="14" viewBox="0 0 12 14" aria-hidden="true"><rect width="12" height="14" rx="3" fill="currentColor"/><rect x="2" y="2" width="8" height="4" rx="1" fill="var(--card)"/><circle cx="3" cy="11" r="1" fill="var(--card)"/><circle cx="9" cy="11" r="1" fill="var(--card)"/></svg>${badge}</span>`,
			}));
		}
		return emptyMark;
	}
	const groups = $derived.by(() => {
		const network = {
			title: tr('The network', 'Le réseau'),
			items: [
				{ label: tr('Line with live data', 'Ligne avec données en direct'), symbol: lineMark },
				{
					label: tr(
						'Line number, on its line or beside it',
						'Numéro de la ligne, sur son tracé ou à côté',
					),
					symbol: numberMark,
				},
				{
					label: tr(
						`Rail${railName ? ` (${railName})` : ''}: schedule only, no live data`,
						`Rail${railName ? ` (${railName})` : ''}\u00a0: horaire seulement, aucune donnée en direct`,
					),
					symbol: railMark,
				},
				{ label: tr('Selected', 'Sélection'), symbol: selectedMark },
			] satisfies MapLegendItem[],
		};
		if (layer !== 'live') return [];
		const colour = live.groups[0]!;
		return [
			{
				title:
					colourBy === 'status'
						? tr(
								'Vehicles, by their delay at the last report',
								'Véhicules, selon le retard au dernier signalement',
							)
						: colour.heading,
				items: colour.rows.map(
					(row): MapLegendItem => ({
						label:
							row.mark.kind === 'status'
								? `${row.label}${locale === 'fr' ? '\u00a0: ' : ': '}${detail[row.mark.code]}`
								: row.label,
						symbol: symbol(row.mark),
					}),
				),
			},
			network,
		];
	});
	const scale = $derived.by((): MapLegendProps['scale'] => {
		if (layer === 'live') return undefined;
		const palette = recordColours[theme.current === 'dark' ? 'dark' : 'light'];
		const labels =
			layer === 'stops'
				? [
						tr('Under 10%', 'Moins de 10 %'),
						tr('10 to <25%', '10 à <25 %'),
						tr('25 to <50%', '25 à <50 %'),
						tr('50% and over', '50 % et plus'),
					]
				: [
						tr('0 s or less', '0 s ou moins'),
						tr('>0 to <30 s', '>0 à <30 s'),
						tr('30 to <60 s', '30 à <60 s'),
						tr('60 s and over', '60 s et plus'),
					];
		return {
			title:
				layer === 'stops'
					? tr(
							'Share of observed stop events that were late',
							'Part des passages observés en retard',
						)
					: tr('Time lost between two stops', 'Temps perdu entre deux arrêts'),
			steps: labels.map((label, index) => ({ label, swatch: palette[index]! })),
			states: [
				{ label: tr('Too few to judge', 'Trop peu pour juger'), symbol: lowSampleMark },
				{ label: tr('Not measured', 'Non mesuré'), symbol: noSampleMark },
				{ label: tr('No live data', 'Aucune donnée en direct'), symbol: scheduleMark },
			],
		};
	});
</script>

{#snippet lineMark()}<span class="map-key-line"></span>{/snippet}
{#snippet railMark()}<span class="map-key-line map-key-rail"></span>{/snippet}
{#snippet selectedMark()}<span class="map-key-line map-key-selected"></span>{/snippet}
{#snippet numberMark()}<RoutePlate code="51" />{/snippet}
{#snippet emptyMark()}{/snippet}
{#snippet lowSampleMark()}<span>●</span>{/snippet}
{#snippet noSampleMark()}<span>○</span>{/snippet}
{#snippet scheduleMark()}<span>⊙</span>{/snippet}

<MapLegend
	class="gap-0 p-2 text-sm leading-tight [--text-small:var(--text-caption)]"
	title={copy[locale].legend.title}
	{groups}
	{scale}
	{collapsible}
	persistKey={collapsible ? 'transit:map-legend-open' : undefined}
	data-map-legend={collapsible ? 'desktop' : 'phone'}
/>

<style>
	.map-key-line {
		width: 100%;
		margin-block-start: 0.65em;
		border-block-start: 0.18em solid var(--muted-foreground);
	}
	.map-key-rail {
		border-block-start-style: dashed;
	}
	.map-key-selected {
		border-color: var(--accent-text);
	}
</style>
