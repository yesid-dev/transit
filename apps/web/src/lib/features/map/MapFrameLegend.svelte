<script lang="ts">
	import ChartDetails from '#lib/components/dataviz/chart/ChartDetails.svelte';
	import { createRawSnippet } from 'svelte';
	import { RoutePlate } from '@yesid/ui/brand';
	import { Card } from '@yesid/ui/card';
	import { MapLegend, type MapLegendItem, type MapLegendProps } from '@yesid/ui/map';
	import { statusVar } from '#lib/components/dataviz/tokens.ts';
	import { mapOccupancyColour } from '#lib/components/map/vehicleSprites.ts';
	import { OCCUPANCY_CODES } from '#lib/v1/schemas/types.ts';
	import { OCCUPANCY_LABELS } from '#lib/v1/enumLabels.ts';
	import type { Locale } from '#lib/i18n/index.ts';
	import { mapRecordReading } from '#lib/site/presenter.ts';
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
		scheduleOnlyLines = true,
		threeD = false,
		heightLimit = null,
		approximate = false,
	}: {
		locale: Locale;
		layer: RecordMapLayer;
		colourBy: LegendColourBy;
		staleCutoffS: number;
		collapsible?: boolean;
		railName?: string;
		/** False hides the rail key for a city that declares no line without live data. */
		scheduleOnlyLines?: boolean;
		threeD?: boolean;
		heightLimit?: number | null;
		approximate?: boolean;
	} = $props();

	let open = $state(true);
	const tr = (en: string, fr: string) => (locale === 'fr' ? fr : en);
	const legendPlacement = $derived(collapsible ? 'desktop' : 'phone');
	const legendClass =
		'gap-0 p-2 text-sm leading-tight [--text-small:var(--text-caption)] [&_ol>li>span]:min-h-[16px]';
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
			return createRawSnippet(() => ({
				render: () =>
					`<svg width="16" height="16" viewBox="0 0 26 26" aria-hidden="true" style="color:${statusVar(mark.code)}"><path fill="currentColor" fill-rule="evenodd" d="M10.5 3.5h5a4 4 0 0 1 4 4v11a4 4 0 0 1-4 4h-5a4 4 0 0 1-4-4v-11a4 4 0 0 1 4-4Zm0.4 2.4a2 2 0 0 0-2 2v1.6a2 2 0 0 0 2 2h4.2a2 2 0 0 0 2-2V7.9a2 2 0 0 0-2-2h-4.2ZM11.25 19.1a1.15 1.15 0 1 0-2.3 0 1.15 1.15 0 0 0 2.3 0Zm5.8 0a1.15 1.15 0 1 0-2.3 0 1.15 1.15 0 0 0 2.3 0Z"/></svg>`,
			}));
		}
		return emptyMark;
	}

	const groups = $derived.by(() => {
		if (layer !== 'live') {
			if (layer !== 'corridors' || !threeD || heightLimit === null) return [];
			return [
				{
					title: `${tr('Top of height scale', 'Sommet de l’échelle')} · ${mapRecordReading(heightLimit, false, locale)}`,
					items: [
						{
							label: tr('Taller than the scale: capped', 'Au-delà\u00a0: hauteur plafonnée'),
							symbol: cappedHeightMark,
						},
					],
				},
			];
		}
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
				...(scheduleOnlyLines
					? [
							{
								label: tr(
									`Rail${railName ? ` (${railName})` : ''}: schedule only, no live data`,
									`Rail${railName ? ` (${railName})` : ''}\u00a0: horaire seulement, aucune donnée en direct`,
								),
								symbol: railMark,
							},
						]
					: []),
				{ label: tr('Selected', 'Sélection'), symbol: selectedMark },
				{ label: copy[locale].legend.stop, symbol: stopMark },
				{ label: copy[locale].legend.heading, symbol: headingMark },
			] satisfies MapLegendItem[],
		};
		if (colourBy === 'occupancy') return [network];
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
								? `${row.label}${row.mark.code === 'early' ? ' (violet)' : ''}${locale === 'fr' ? '\u00a0: ' : ': '}${detail[row.mark.code]}`
								: row.label,
						symbol: symbol(row.mark),
					}),
				),
			},
			network,
		];
	});
	const scale = $derived.by((): MapLegendProps['scale'] => {
		if (layer === 'live') {
			if (colourBy !== 'occupancy') return undefined;
			return {
				title: tr('Room on board', 'Places à bord'),
				steps: OCCUPANCY_CODES.map((code) => ({
					label: OCCUPANCY_LABELS[locale][code],
					swatch: mapOccupancyColour(code),
				})),
			};
		}
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
						layer === 'waits'
							? tr('No extra wait', 'Aucune attente en plus')
							: tr('No time lost', 'Aucun temps perdu'),
						tr('Under 30\u00a0s', 'Moins de 30\u00a0s'),
						tr('30 to under 60\u00a0s', '30 à moins de 60\u00a0s'),
						tr('1 to under 2\u00a0min', '1 à moins de 2\u00a0min'),
						tr('2\u00a0min and over', '2\u00a0min et plus'),
					];
		return {
			title:
				layer === 'stops'
					? tr(
							'Share of recorded stop arrivals that were late',
							'Part des passages enregistrés en retard',
						)
					: layer === 'waits'
						? tr('Extra wait at each stop', 'Attente en plus à chaque arrêt')
						: layer === 'clear-run'
							? tr('Time lost against the clear run', 'Temps perdu par rapport au parcours fluide')
							: tr('Time lost between two stops', 'Temps perdu entre deux arrêts'),
			steps: labels.map((label, index) => ({ label, swatch: recordColours[index]! })),
			states: [
				{ label: tr('Too few to judge', 'Trop peu pour juger'), symbol: lowSampleMark },
				{ label: tr('Not measured', 'Non mesuré'), symbol: noSampleMark },
				{ label: tr('No live data', 'Aucune donnée en direct'), symbol: scheduleMark },
				...((layer === 'corridors' || layer === 'clear-run') && approximate
					? [
							{
								label: tr('Straight between stops', 'Tracé direct entre les arrêts'),
								symbol: approximateMark,
							},
						]
					: []),
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
{#snippet stopMark()}
	<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
		<path d="M8 14C7 12 3 9 3 6a5 5 0 1 1 10 0c0 3-4 6-5 8Z" fill="var(--map-stop-fill)" />
		<circle cx="8" cy="6" r="1.5" fill="var(--card)" />
	</svg>
{/snippet}
{#snippet headingMark()}
	<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
		<path d="m8 3 5 7-5-2-5 2Z" fill="currentColor" />
	</svg>
{/snippet}
{#snippet numberMark()}<RoutePlate code="51" />{/snippet}
{#snippet emptyMark()}{/snippet}
{#snippet unmeasuredMark(state: 0 | 1 | 2)}
	<svg class="record-state-mark text-muted-foreground" viewBox="0 0 32 12" aria-hidden="true">
		{#if layer === 'stops' || layer === 'waits'}
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
{#snippet approximateMark()}{@render networkLine('var(--foreground)', '1 3')}{/snippet}
{#snippet cappedHeightMark()}
	<span
		class="size-3 shrink-0 rounded-sm border border-current bg-[var(--map-corridor-cap)]"
		data-corridor-cap-swatch
		aria-hidden="true"
	></span>
{/snippet}

<ChartDetails
	label={scale?.title ?? copy[locale].legend.title}
	targets="ol[aria-label] > li"
	readings={open
		? (scale?.steps ?? []).map((step) => ({
				key: step.label,
				heading: scale!.title,
				rows: [{ label: tr('Range', 'Plage'), value: step.label, colorVar: step.swatch }],
			}))
		: []}
>
	<Card
		edge="neutral"
		class={legendClass}
		data-map-legend={legendPlacement}
		data-record-legend={layer !== 'live' ? '' : undefined}
	>
		<MapLegend
			bind:open
			class="contents"
			title={copy[locale].legend.title}
			{groups}
			{scale}
			scalePlacement="before-groups"
			{collapsible}
			persistKey={collapsible ? 'transit:map-legend-open' : undefined}
		/>
		{#if open && layer === 'waits'}
			<p class="mt-2 text-muted-foreground" data-waits-legend-note>
				{tr(
					'The map shows the longest wait at each stop. The list breaks it down by line and direction.',
					'La carte montre la plus longue attente à chaque arrêt. La liste la détaille par ligne et direction.',
				)}
			</p>
		{/if}
	</Card>
</ChartDetails>

<style>
	:global([data-map-legend]) {
		container: map-legend / inline-size;
	}

	:global([data-map-legend] :is(button, p, li, ol[role='list'])) {
		overflow-wrap: normal;
		word-break: normal;
		hyphens: none;
	}

	/* Give each swatch and its label room for the longest word in that label. */
	:global([data-map-legend] ol[role='list']) {
		grid-template-columns: repeat(var(--legend-steps), minmax(min-content, 1fr));
	}

	:global([data-record-legend] .group-title) {
		margin-block: 0.375rem 0.25rem;
	}

	:global([data-record-legend] .ramp) {
		margin-block-end: 0.375rem;
	}

	:global([data-record-legend] .items) {
		gap: 0.125rem;
	}

	@container map-legend (inline-size < 14rem) {
		:global([data-map-legend] ol[role='list']) {
			grid-template-columns: minmax(0, 1fr);
			gap: 0.25rem;
			text-align: start;
		}

		:global([data-map-legend] ol[role='list'] > li) {
			display: grid;
			grid-template-columns: 1.5em minmax(0, 1fr);
			align-items: center;
			gap: 0.5em;
		}

		:global([data-map-legend] ol[role='list'] > li > [aria-hidden='true']) {
			margin-block-end: 0;
			border-radius: var(--radius-sm);
		}
	}

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
