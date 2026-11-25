<script lang="ts">
	import { createRawSnippet } from 'svelte';
	import { RoutePlate, statusGlyphSvg } from '@yesid/ui/brand';
	import { MapLegend, type MapLegendItem, type MapLegendProps } from '@yesid/ui/map';
	import { theme } from '@yesid/ui/state';
	import { OCCUPANCY_GLYPH, occupancyVar, statusVar } from '#lib/components/dataviz/tokens.ts';
	import type { Locale } from '#lib/i18n/index.ts';
	import { ON_TIME_LIMITS_S } from '#lib/v1/live/statusBands.ts';
	import { mapLegend, type LegendColourBy, type LegendMark } from './mapLegend';
	import { copy } from './map.copy';
	import { recordColours, recordUnmeasuredLine, type RecordMapLayer } from './recordMap';

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
		if (mark.kind === 'status') {
			const glyph = statusGlyphSvg(mark.code, { size: 16, ink: 'currentColor' });
			return createRawSnippet(() => ({
				render: () =>
					`<span class="inline-flex" aria-hidden="true" style="color:${statusVar(mark.code)}">${glyph}</span>`,
			}));
		}
		if (mark.kind === 'occupancy') {
			return createRawSnippet(() => ({
				render: () =>
					`<span style="color:${occupancyVar(mark.code)}" aria-hidden="true">${OCCUPANCY_GLYPH[mark.code]}</span>`,
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
	const palette = $derived(recordColours[theme.current === 'dark' ? 'dark' : 'light']);
	const scale = $derived.by((): MapLegendProps['scale'] => {
		if (layer === 'live') return undefined;
		const labels =
			layer === 'stops'
				? [
						tr('Under 10%', 'Moins de 10 %'),
						tr('10 to under 15%', '10 à moins de 15 %'),
						tr('15 to under 20%', '15 à moins de 20 %'),
						tr('20 to under 25%', '20 à moins de 25 %'),
						tr('25% and over', '25 % et plus'),
					]
				: [
						tr('No time lost', 'Aucun temps perdu'),
						tr('Under 30 seconds', 'Moins de 30 secondes'),
						tr('30 to under 60 seconds', '30 à moins de 60 secondes'),
						tr('1 to under 2 minutes', '1 à moins de 2 minutes'),
						tr('2 minutes and over', '2 minutes et plus'),
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

{#snippet networkLine(ink: string, dash?: string)}
	<svg class="map-key-line" viewBox="0 0 32 12" aria-hidden="true">
		<line x1="0" y1="8" x2="32" y2="8" stroke={ink} stroke-width="2" stroke-dasharray={dash} />
	</svg>
{/snippet}
{#snippet lineMark()}{@render networkLine('var(--muted-foreground)')}{/snippet}
{#snippet railMark()}{@render networkLine('var(--muted-foreground)', '4 3')}{/snippet}
{#snippet selectedMark()}{@render networkLine('var(--accent-text)')}{/snippet}
{#snippet numberMark()}<RoutePlate code="51" />{/snippet}
{#snippet emptyMark()}{/snippet}
{#snippet unmeasuredMark(state: 0 | 1 | 2)}
	<svg class="record-state-mark text-muted-foreground" viewBox="0 0 32 12" aria-hidden="true">
		{#if layer === 'stops'}
			<circle
				cx="16"
				cy="6"
				r="3"
				fill={state === 1 ? 'currentColor' : 'none'}
				stroke={state === 1 ? 'none' : 'currentColor'}
				stroke-width="1.5"
			/>
			{#if state === 2}<circle cx="16" cy="6" r="1.25" fill="currentColor" />{/if}
		{:else}
			<line
				x1="1"
				y1="6"
				x2="31"
				y2="6"
				stroke="currentColor"
				stroke-linecap="round"
				stroke-width={recordUnmeasuredLine.width}
				stroke-dasharray={recordUnmeasuredLine.dashes[state]
					.map((length) => length * recordUnmeasuredLine.width)
					.join(' ')}
			/>
		{/if}
	</svg>
{/snippet}
{#snippet lowSampleMark()}{@render unmeasuredMark(1)}{/snippet}
{#snippet noSampleMark()}{@render unmeasuredMark(0)}{/snippet}
{#snippet scheduleMark()}{@render unmeasuredMark(2)}{/snippet}

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
	.record-state-mark {
		inline-size: 2rem;
		block-size: 0.75rem;
		margin-block-start: 0.15em;
	}
	.map-key-line {
		inline-size: 100%;
		block-size: 0.75rem;
	}
</style>
