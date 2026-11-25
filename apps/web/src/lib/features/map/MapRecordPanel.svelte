<script lang="ts">
	import { mapRecordReading } from '#lib/site/presenter.ts';
	import { transitDisplay } from '#lib/site/transitDisplayContext.ts';
	import { directionHeadsigns } from '#lib/features/lines/directions.ts';
	import type { Map as MapLibreMap } from 'maplibre-gl';
	import { untrack, type Snippet } from 'svelte';
	import { Card } from '@yesid/ui/card';
	import { theme } from '@yesid/ui/state';
	import { localizeHref, type Locale } from '#lib/i18n/index.ts';
	import { choose, notMeasuredLabel } from '#lib/features/record/recordText.ts';
	import RecordPending from '#lib/features/record/RecordPending.svelte';
	import RecordAnswer from '#lib/features/record/RecordAnswer.svelte';
	import { Button } from '@yesid/ui/button';
	import { frameHref, type parseFrameState } from '#lib/site/frameState.ts';
	import { lineIsScheduleOnly } from '#lib/site/providerCapabilities.ts';
	import { getRoute } from '#lib/v1/repositories/static.ts';
	import { getMapRoutes } from '#lib/v1/repositories/scheduleShapes.ts';
	import type { RouteFile, StopIndexEntry } from '#lib/v1/schemas/index.ts';
	import type { RouteIndexEntry } from '#lib/v1/schemas/routes_index.ts';
	import { getV1Context } from '#lib/v1/boot.ts';
	import type { MapRecordAnswer } from './recordMapAnswer';
	import {
		isCoordinateInCapturedView,
		isLineInCapturedView,
		type MapReportCamera,
	} from './mapReportCamera';
	import { attachRecordMap } from './recordMapLayers';
	import {
		recordColours,
		recordCorridors,
		recordFeatures,
		recordMapSampleText,
		recordStops,
		type RecordMapLayer,
	} from './recordMap';

	interface Props {
		map: MapLibreMap | null;
		layer: RecordMapLayer;
		line: string;
		direction: string;
		city: string;
		period: ReturnType<typeof parseFrameState>['period'];
		url: URL;
		locale: Locale;
		stops: readonly StopIndexEntry[];
		routes: readonly RouteIndexEntry[];
		onscope: (line: string, direction: string) => void;
		onsourcedate: (date: string | null) => void;
		reportCamera?: MapReportCamera | null;
		oncount?: (count: number | null) => void;
		children?: Snippet<[Snippet | undefined]>;
	}
	let {
		map,
		layer,
		line,
		direction,
		city,
		period,
		url,
		locale,
		stops,
		routes,
		onscope,
		onsourcedate,
		reportCamera,
		oncount,
		children,
	}: Props = $props();
	const { provider } = getV1Context();
	const display = transitDisplay();
	const tr = (en: string, fr: string) => choose(locale, en, fr);
	const stopLayer = $derived(layer === 'stops');
	const network = $derived(layer === 'corridors' && !line);
	const scope = $derived(
		period && layer !== 'live'
			? new URLSearchParams({
					city,
					from: period.from,
					to: period.to,
					...(network ? { layer: 'corridors' } : {}),
					...(!stopLayer && line ? { line, ...(direction ? { direction } : {}) } : {}),
				}).toString()
			: '',
	);
	const palette = $derived(recordColours[theme.current === 'dark' ? 'dark' : 'light']);
	const routeTypes = $derived(new Map(routes.map((route) => [route.id, route.type ?? null])));
	const scheduleOnly = $derived(lineIsScheduleOnly(provider, line, routeTypes.get(line) ?? null));
	let request = $state.raw<{
		key: string;
		answer: (MapRecordAnswer & { stale?: boolean }) | null;
		chooseLine?: boolean;
	} | null>(null);
	const answer = $derived(request?.key === scope ? request.answer : null);
	$effect(() => onsourcedate(answer?.evidence.source_date ?? null));
	const pending = $derived(Boolean(scope && scope !== request?.key));
	const chooseLine = $derived(
		network && (!scope || (request?.key === scope && request.chooseLine)),
	);
	let routeResult = $state.raw<{ id: string; route: RouteFile | null } | null>(null);
	const route = $derived(routeResult?.id === line ? routeResult.route : null);
	let selectedId = $state<string | null>(null);
	let search = $state('');
	let searchInput = $state<HTMLInputElement | null>(null);
	let fitted: { map: MapLibreMap; line: string; direction: string } | null = null;

	$effect(() => {
		const key = scope;
		request = null;
		selectedId = null;
		search = '';
		if (!key) return;
		const controller = new AbortController();
		void fetch(`/api/map-record?${key}`, { signal: controller.signal })
			.then(async (response) => {
				if (response.status === 409) {
					if (!controller.signal.aborted) request = { key, answer: null, chooseLine: true };
					return;
				}
				if (!response.ok) throw new Error('Record unavailable');
				const answer: MapRecordAnswer & { stale?: boolean } = await response.json();
				if (!controller.signal.aborted) request = { key, answer };
			})
			.catch(() => {
				if (!controller.signal.aborted) request = { key, answer: null };
			});
		return () => controller.abort();
	});

	$effect(() => {
		const id = line;
		routeResult = null;
		if (layer !== 'corridors' || !id) return;
		const controller = new AbortController();
		const context = { providerId: city, signal: controller.signal };
		const edition = getRoute(id, context).catch(() => null);
		const shaped = getMapRoutes([id], context).then(
			([route]) => route,
			() => null,
		);
		void edition.then(async (route) => {
			if (controller.signal.aborted) return;
			routeResult = { id, route };
			const mapRoute = await shaped;
			if (mapRoute && !controller.signal.aborted) routeResult = { id, route: mapRoute };
		});
		return () => controller.abort();
	});

	const marks = $derived.by(() => {
		if (!answer) return [];
		if (!stopLayer)
			return recordCorridors(stops, route?.directions ?? [], answer, direction, scheduleOnly);
		return recordStops(stops, answer, (stop) =>
			Boolean(
				stop.routes?.length &&
				stop.routes.every((id) => lineIsScheduleOnly(provider, id, routeTypes.get(id) ?? null)),
			),
		);
	});
	const markById = $derived(new Map(marks.map((mark) => [mark.id, mark])));
	const selected = $derived(selectedId === null ? null : (markById.get(selectedId) ?? null));
	const visible = $derived.by(() => {
		const camera = reportCamera;
		if (!camera) return [];
		return marks
			.filter(({ geometry }) =>
				geometry.type === 'Point'
					? isCoordinateInCapturedView(camera, geometry.coordinates)
					: isLineInCapturedView(camera, geometry.coordinates),
			)
			.sort((a, b) => (b.value ?? -Infinity) - (a.value ?? -Infinity));
	});
	const leader = $derived(visible.find((mark) => mark.state === 3 && mark.value !== null));
	let limit = $state(12);
	$effect(() => {
		void scope;
		limit = 12;
	});
	$effect(() => oncount?.(answer && reportCamera ? visible.length : null));
	const matching = $derived(
		search.trim()
			? marks
					.filter(({ name, stop }) =>
						`${name} ${stop ?? ''}`
							.toLocaleLowerCase(locale)
							.includes(search.trim().toLocaleLowerCase(locale)),
					)
					.slice(0, 12)
			: [],
	);
	$effect(() => {
		if (!map || !marks.length) return;
		return attachRecordMap(
			map,
			recordFeatures(marks, theme.current === 'dark' ? 'dark' : 'light', stopLayer),
			(id) => (selectedId = id),
			network,
		);
	});
	$effect(() => {
		const instance = map;
		const id = line;
		const dir = direction;
		if (stopLayer || !id) {
			fitted = null;
			return;
		}
		if (
			!instance ||
			!marks.length ||
			(fitted?.map === instance && fitted.line === id && fitted.direction === dir)
		)
			return;
		const coordinates = marks.flatMap(({ geometry }) =>
			geometry.type === 'LineString' ? geometry.coordinates : [],
		);
		if (!coordinates.length) return;
		const lon = coordinates.map(([x]) => x);
		const lat = coordinates.map(([, y]) => y);
		const bounds = [
			[Math.min(...lon), Math.min(...lat)],
			[Math.max(...lon), Math.max(...lat)],
		] as [[number, number], [number, number]];
		if (bounds[0][0] === bounds[1][0] && bounds[0][1] === bounds[1][1]) return;
		untrack(() => {
			const frame = instance.getContainer().getBoundingClientRect();
			const head = instance
				.getContainer()
				.closest('.map-surface')
				?.querySelector('.map-layer-controls')
				?.getBoundingClientRect();
			const top = Math.max(32, (head?.bottom ?? frame.top) - frame.top + 12);
			instance.fitBounds(bounds, {
				padding: { top, left: 32, right: 32, bottom: 48 },
				maxZoom: 15,
				duration: 0,
			});
		});
		fitted = { map: instance, line: id, direction: dir };
	});

	const heads = $derived(directionHeadsigns(route?.directions));
	const stateLabels = $derived([
		notMeasuredLabel[locale],
		tr('Too few to judge', 'Trop peu pour juger'),
		tr('No live data', 'Aucune donnée en direct'),
		tr('Measured', 'Mesuré'),
	]);
	const units = $derived(
		stopLayer
			? tr('Late stop events (%)', 'Passages en retard (%)')
			: tr('Mean time lost (s per run)', 'Temps perdu moyen (s par parcours)'),
	);
	const bins = $derived(
		stopLayer
			? [
					tr('Under 10%', 'Moins de 10 %'),
					tr('10 to <25%', '10 à <25 %'),
					tr('25 to <50%', '25 à <50 %'),
					tr('50% or more', '50 % ou plus'),
				]
			: [
					tr('0 s or less', '0 s ou moins'),
					tr('>0 to <30 s', '>0 à <30 s'),
					tr('30 to <60 s', '30 à <60 s'),
					tr('60 s or more', '60 s ou plus'),
				],
	);
	const routeNames = $derived(new Map(routes.map((route) => [route.id, route.long])));
	function recordLink(id: string, dir?: number | null) {
		const target = new URL(
			localizeHref(`/${stopLayer ? 'stop' : 'lines'}/${encodeURIComponent(id)}`, locale, city),
			url,
		);
		if (dir != null) target.searchParams.set('direction', String(dir));
		return frameHref(target, { mode: 'record', period });
	}
	const recordHref = $derived(
		stopLayer
			? selected?.stop && recordLink(selected.stop)
			: line && recordLink(line, selected?.direction),
	);
	const sampleText = $derived(selected ? recordMapSampleText(selected, stopLayer, locale) : null);
	function valueText(value: number) {
		return mapRecordReading(value, stopLayer, locale);
	}
</script>

{#snippet recordContent()}
	<div class="record-panel" class:record-panel-standalone={!children}>
		<Card edge="neutral" class={children ? 'p-0' : 'p-3'}>
			{#if leader?.value != null}
				<RecordAnswer
					value={valueText(leader.value)}
					sentence={stopLayer
						? tr(
								`is the highest late share of observed stop events in view, at ${leader.name}.`,
								`: la part de passages observés en retard la plus élevée en vue, à l’arrêt ${leader.name}.`,
							)
						: tr(
								`is the most time lost between two stops in view, at ${leader.name}.`,
								`: le temps perdu le plus élevé entre deux arrêts en vue, à ${leader.name}.`,
							)}
					{locale}
				/>
			{/if}
			{#if !stopLayer}
				<div class="scope">
					<label>
						{tr('Line', 'Ligne')}
						<select value={line} onchange={(event) => onscope(event.currentTarget.value, '')}>
							<option value=""
								>{chooseLine
									? tr('Choose a line', 'Choisir une ligne')
									: tr('All lines', 'Toutes les lignes')}</option
							>
							{#each routes as item (item.id)}
								<option value={item.id}>{display.lineName(item.id, item.long).label}</option>
							{/each}
						</select>
					</label>
					{#if line}
						<label>
							{tr('Direction', 'Direction')}
							<select
								value={direction}
								onchange={(event) => onscope(line, event.currentTarget.value)}
							>
								<option value="">{tr('Both directions', 'Les deux directions')}</option>
								<option value="0">{display.directionLabel(0, heads, locale)}</option>
								<option value="1">{display.directionLabel(1, heads, locale)}</option>
							</select>
						</label>
					{/if}
				</div>
			{/if}
			{#if chooseLine}
				<p>
					{tr(
						'Choose a line to see time lost between its stops.',
						'Choisissez une ligne pour voir le temps perdu entre ses arrêts.',
					)}
				</p>
			{:else}
				{#if !children}<section
						aria-label={tr('Record map legend', 'Légende de la carte du bilan')}
						data-slot="record-map-legend"
					>
						<h2>{units}</h2>
						{#if !stopLayer}
							<p>
								{tr(
									'Compared with the timetable for the same runs.',
									'Par rapport à l’horaire des mêmes parcours.',
								)}
							</p>
							{#if network}
								<p>
									{tr(
										'The map draws a straight line between each pair of stops.',
										'La carte relie chaque paire d’arrêts par un trait droit.',
									)}
								</p>
							{/if}
						{/if}
						<ul class="bins">
							{#each bins as label, i (label)}
								<li style:--swatch={palette[i]}>{label}</li>
							{/each}
						</ul>
						<ul class="states" class:stops={stopLayer}>
							{#each [1, 0, 2] as state (state)}
								<li
									data-state={state}
									style:--swatch={palette[state === 1 ? 5 : state === 2 ? 6 : 4]}
								>
									<span aria-hidden="true"></span>{stateLabels[state]}
								</li>
							{/each}
						</ul>
					</section>{/if}
				{#if pending}
					{#key scope}<RecordPending {locale} />{/key}
				{:else if !answer}
					<p role="status">
						{tr(
							'The record is temporarily unavailable.',
							'Le bilan est temporairement indisponible.',
						)}
					</p>
				{:else}
					{#if answer.stale}
						<p>{tr('Showing the last available answer.', 'Dernier résultat disponible.')}</p>
					{/if}
					{#if answer.evidence.days_not_measured.length > 0}
						<p>
							{tr(
								'Some days in this period have no measurements.',
								'Certaines journées de cette période n’ont aucune mesure.',
							)}
						</p>
					{/if}
					{#if marks.length > 0}
						{#if children && reportCamera}
							<section
								aria-label={stopLayer
									? tr('Stops in view', 'Arrêts en vue')
									: tr('Corridors in view', 'Corridors en vue')}
								data-slot="map-in-view"
							>
								<h2>
									{stopLayer
										? tr('Stops in view', 'Arrêts en vue')
										: tr('Corridors in view', 'Corridors en vue')}
									<span class="tabular-nums">({visible.length})</span>
								</h2>
								<ul>
									{#each visible.slice(0, limit) as mark (mark.id)}
										<li class="record-in-view-row">
											<Button
												variant="ghost"
												size="sm"
												class="min-h-11"
												wrap
												onclick={() => (selectedId = mark.id)}>{mark.name}</Button
											>
											<span
												>{mark.value !== null
													? valueText(mark.value)
													: stateLabels[mark.state]}</span
											>
										</li>
									{/each}
								</ul>
								{#if visible.length > limit}
									<Button variant="outline" size="sm" class="min-h-11" onclick={() => (limit += 12)}
										>{tr('Show 12 more', 'Afficher 12 de plus')}</Button
									>
								{/if}
							</section>
						{/if}
						<label class="find">
							{stopLayer
								? tr('Find a stop', 'Trouver un arrêt')
								: tr('Find a segment', 'Trouver un segment')}
							<input type="search" bind:this={searchInput} bind:value={search} />
						</label>
						{#if matching.length > 0}
							<ul class="results">
								{#each matching as mark (mark.id)}
									<li>
										<button
											type="button"
											onclick={() => {
												selectedId = mark.id;
												search = '';
												searchInput?.focus({ preventScroll: true });
											}}>{mark.name}</button
										>
									</li>
								{/each}
							</ul>
						{/if}
					{:else}
						<p>
							{tr(
								'No locations are available for this selection.',
								'Aucun emplacement disponible pour cette sélection.',
							)}
						</p>
					{/if}
				{/if}
				<div role="status" aria-atomic="true" data-slot="record-map-selection">
					{#if selected}
						{#if children}<Button
								variant="ghost"
								size="sm"
								class="min-h-11"
								onclick={() => (selectedId = null)}>{tr('Back', 'Retour')}</Button
							>{/if}
						<h2>{selected.name}</h2>
						<p>
							{stateLabels[selected.state]}{selected.value !== null
								? ` · ${valueText(selected.value)}`
								: ''}
						</p>
						{#if sampleText}
							<p>{sampleText}</p>
						{/if}
					{/if}
				</div>
				{#if selected && recordHref}
					<a class="record-link" href={recordHref}
						>{stopLayer
							? tr('Stop Record', 'Bilan de l’arrêt')
							: tr('Line Record', 'Bilan de la ligne')}</a
					>
				{/if}
				{#if network && selected?.lines?.length}
					<ul aria-label={tr('Lines serving this segment', 'Lignes qui desservent ce segment')}>
						{#each selected.lines as id (id)}
							<li>
								<a class="record-link" href={recordLink(id)}
									>{display.lineName(id, routeNames.get(id)).label}</a
								>
							</li>
						{/each}
					</ul>
				{/if}
			{/if}
		</Card>
	</div>
{/snippet}

{#if children}
	{@render children(layer === 'live' ? undefined : recordContent)}
{:else if layer !== 'live'}
	{@render recordContent()}
{/if}

<style>
	.record-panel {
		color: var(--foreground);
		font-size: var(--text-small);
		line-height: 1.35;
	}
	.record-panel-standalone {
		width: min(26rem, calc(100vw - 1.5rem));
		max-height: min(27rem, 48dvh);
		overflow: auto;
		overscroll-behavior: contain;
	}
	.record-in-view-row {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: calc(var(--spacing) * 2);
		border-block-start: 1px solid var(--border-hairline);
	}
	.record-in-view-row span {
		text-align: end;
		font-variant-numeric: tabular-nums;
	}
	p,
	h2,
	ul {
		margin: 0;
	}
	h2 {
		font-size: inherit;
		font-weight: 700;
	}
	ul {
		list-style: none;
		padding: 0;
	}
	.bins {
		display: grid;
		grid-template-columns: repeat(4, minmax(0, 1fr));
		gap: 0.375rem;
	}
	.bins li {
		border-top: 0.3rem solid var(--swatch);
		padding-top: 0.25rem;
	}
	.states {
		display: flex;
		flex-wrap: wrap;
		gap: 0.25rem 0.75rem;
		margin-top: 0.5rem;
	}
	.states li {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
	}
	.states span {
		width: 1rem;
		height: 0.375rem;
		border-top: 0.18rem solid var(--swatch);
	}
	.states [data-state='0'] span {
		border-top-style: dotted;
	}
	.states [data-state='1'] span,
	.states [data-state='2'] span {
		border-top-style: dashed;
	}
	.states [data-state='2'] span {
		border-bottom: 0.1rem solid var(--swatch);
	}
	.states.stops span {
		width: 0.65rem;
		height: 0.65rem;
		border: 0.125rem solid var(--swatch);
		border-radius: 50%;
	}
	.states.stops [data-state='1'] span {
		background: var(--swatch);
	}
	.states.stops [data-state='2'] span {
		background: radial-gradient(var(--swatch) 35%, transparent 40%);
	}
	.scope {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
	}
	label {
		display: grid;
		gap: 0.2rem;
		min-width: 0;
		font-weight: 600;
	}
	.scope label {
		flex: 1 1 8rem;
	}
	select,
	input {
		width: 100%;
		min-width: 0;
		min-height: var(--size-tap-min);
		background: var(--background);
		color: var(--foreground);
		border: 1px solid var(--muted-foreground);
		border-radius: var(--radius-sm);
		padding-inline: 0.5rem;
	}
	button,
	.record-link {
		min-height: var(--size-tap-min);
		text-align: start;
	}
	.record-link {
		display: inline-flex;
		align-items: center;
		width: fit-content;
		text-decoration: underline;
	}
	.results {
		max-height: 8rem;
		overflow: auto;
	}
	.results button {
		width: 100%;
		padding-inline: 0.25rem;
	}
</style>
