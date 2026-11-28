<script lang="ts">
	import { mapRecordReading, searchCount } from '#lib/site/presenter.ts';
	import { resolveColor } from '#lib/components/map/vehicleSprites.ts';
	import { transitDisplay } from '#lib/site/transitDisplayContext.ts';
	import type { Map as MapLibreMap } from 'maplibre-gl';
	import { untrack, type Snippet } from 'svelte';
	import { Separator } from '@yesid/ui/separator';
	import { theme } from '@yesid/ui/state';
	import { localizeHref, type Locale } from '#lib/i18n/index.ts';
	import { choose, notMeasuredLabel } from '#lib/features/record/recordText.ts';
	import RecordPending from '#lib/features/record/RecordPending.svelte';
	import MapPanelAnswer from './MapPanelAnswer.svelte';
	import MapPanelRow from './MapPanelRow.svelte';
	import { Button } from '@yesid/ui/button';
	import { frameHref, type parseFrameState } from '#lib/site/frameState.ts';
	import { lineIsScheduleOnly } from '#lib/site/providerCapabilities.ts';
	import { getRoute } from '#lib/v1/repositories/static.ts';
	import { getMapRoutes } from '#lib/v1/repositories/scheduleShapes.ts';
	import type { RouteFile, StopIndexEntry } from '#lib/v1/schemas/index.ts';
	import type { RouteIndexEntry } from '#lib/v1/schemas/routes_index.ts';
	import { getV1Context } from '#lib/v1/boot.ts';
	import { mapReadingHours, type MapReadingFilters } from '#lib/filters/mapReadings.ts';
	import type { MapRecordAnswer } from './recordMapAnswer';
	import {
		isCoordinateInCapturedView,
		isLineInCapturedView,
		type MapReportCamera,
	} from './mapReportCamera';
	import { measureMapFocusInset } from './mapFocusInset';
	import { attachRecordMap } from './recordMapLayers';
	import { recordExtrusions } from './recordExtrusions';
	import {
		ALL_CORRIDORS_MIN_ZOOM,
		OTHER_STOPS_MIN_ZOOM,
		overviewCorridors,
		recordColours,
		recordCorridors,
		recordFeatures,
		recordMapSampleText,
		recordStops,
		recordStopIsVisible,
		type RecordMapLayer,
		type RecordMark,
	} from './recordMap';

	interface Props {
		map: MapLibreMap | null;
		layer: RecordMapLayer;
		line: string;
		lines?: readonly string[];
		readings?: MapReadingFilters;
		direction: string;
		city: string;
		period: ReturnType<typeof parseFrameState>['period'];
		url: URL;
		locale: Locale;
		stops: readonly StopIndexEntry[];
		terminals: ReadonlySet<string>;
		routes: readonly RouteIndexEntry[];
		onlinefilters: () => void;
		onsourcedate: (date: string | null) => void;
		ondata?: (settled: boolean) => void;
		scheduleCache?: Map<string, unknown>;
		reportCamera?: MapReportCamera | null;
		threeD?: boolean;
		oncount?: (count: number | null) => void;
		children: Snippet<[Snippet<[Snippet | undefined]> | undefined, string | null]>;
	}
	let {
		map,
		layer,
		line,
		lines = [],
		readings,
		direction,
		city,
		period,
		url,
		locale,
		stops,
		terminals,
		routes,
		onlinefilters,
		onsourcedate,
		ondata,
		scheduleCache,
		reportCamera,
		threeD = false,
		oncount,
		children,
	}: Props = $props();
	const { provider } = getV1Context();
	const display = transitDisplay();
	const tr = (en: string, fr: string) => choose(locale, en, fr);
	const stopLayer = $derived(layer === 'stops');
	const network = $derived(layer === 'corridors' && !line);
	const hours = $derived(mapReadingHours(readings?.timeOfDay));
	const scopedDirection = $derived(
		readings?.direction !== undefined
			? String(readings.direction)
			: !stopLayer && line
				? direction
				: '',
	);
	const scope = $derived(
		period && layer !== 'live'
			? new URLSearchParams({
					city,
					from: period.from,
					to: period.to,
					...(network ? { layer: 'corridors' } : {}),
					...(!stopLayer && line ? { line } : lines.length ? { lines: JSON.stringify(lines) } : {}),
					...(scopedDirection ? { direction: scopedDirection } : {}),
					...(readings?.vehicleType !== undefined
						? { route_type: String(readings.vehicleType) }
						: {}),
					...(hours ? { hour_from: String(hours[0]), hour_to: String(hours[1]) } : {}),
				}).toString()
			: '',
	);
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
	$effect(() => {
		ondata?.(!pending && (layer !== 'corridors' || !line || routeResult?.id === line));
	});
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
		if (!map || layer !== 'corridors' || !id) return;
		const controller = new AbortController();
		const context = { providerId: city, signal: controller.signal, cache: scheduleCache };
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
		return recordStops(
			stops,
			answer,
			(stop) =>
				Boolean(
					stop.routes?.length &&
					stop.routes.every((id) => lineIsScheduleOnly(provider, id, routeTypes.get(id) ?? null)),
				),
			terminals,
		);
	});
	const markById = $derived(new Map(marks.map((mark) => [mark.id, mark])));
	const selected = $derived(selectedId === null ? null : (markById.get(selectedId) ?? null));
	const corridorOverview = $derived(network ? overviewCorridors(marks) : marks);
	const atCorridorOverview = $derived((reportCamera?.zoom ?? 0) < ALL_CORRIDORS_MIN_ZOOM);
	const drawn = $derived(atCorridorOverview ? corridorOverview : marks);
	const showStopScope = $derived(
		stopLayer &&
			reportCamera &&
			reportCamera.zoom < OTHER_STOPS_MIN_ZOOM &&
			marks.some((mark) => !mark.main),
	);
	const overviewIncludesOtherStops = $derived(
		stopLayer && marks.some((mark) => mark.main && !terminals.has(mark.id)),
	);
	const visible = $derived.by(() => {
		const camera = reportCamera;
		if (!camera) return [];
		return drawn
			.filter((mark) =>
				mark.geometry.type === 'Point'
					? recordStopIsVisible(mark, camera.zoom) &&
						isCoordinateInCapturedView(camera, mark.geometry.coordinates)
					: isLineInCapturedView(camera, mark.geometry.coordinates),
			)
			.sort((a, b) => (b.value ?? -Infinity) - (a.value ?? -Infinity));
	});
	const leader = $derived(visible.find((mark) => mark.state === 3 && mark.value !== null));
	const leaderStop = $derived(
		leader?.stop ? (stops.find((stop) => stop.id === leader.stop)?.code ?? leader.stop) : null,
	);
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
		if (!map || !drawn.length) return;
		const palette = theme.current === 'dark' ? 'dark' : 'light';
		const mutedInk = resolveColor(
			'var(--muted-foreground)',
			palette === 'dark' ? '#949494' : '#545e75',
		);
		// MapLibre takes sRGB values, while the legend can use the CSS token mixes directly.
		const canvas = document.createElement('canvas');
		canvas.width = canvas.height = 1;
		const context = canvas.getContext('2d', { willReadFrequently: true });
		const resolvedRamp = recordColours[stopLayer ? 'stops' : 'corridors'].map((colour) => {
			if (!context) return mutedInk;
			context.fillStyle = resolveColor(colour, mutedInk);
			context.fillRect(0, 0, 1, 1);
			const [red, green, blue] = context.getImageData(0, 0, 1, 1).data;
			return `rgb(${red}, ${green}, ${blue})`;
		});
		const features = recordFeatures(drawn, resolvedRamp, stopLayer, mutedInk);
		return attachRecordMap(
			map,
			features,
			(id) => (selectedId = id),
			network,
			resolveColor('var(--foreground)', mutedInk),
			threeD && layer === 'corridors'
				? recordExtrusions(features, (id) => markById.get(id)?.value)
				: undefined,
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
			instance.fitBounds(bounds, {
				padding: measureMapFocusInset(instance).fitPadding,
				maxZoom: 15,
				duration: 0,
			});
		});
		fitted = { map: instance, line: id, direction: dir };
	});

	const stateLabels = $derived([
		notMeasuredLabel[locale],
		tr('Too few to judge', 'Trop peu pour juger'),
		tr('No live data', 'Aucune donnée en direct'),
		tr('Measured', 'Mesuré'),
	]);
	const routeNames = $derived(new Map(routes.map((route) => [route.id, route.long])));
	const stopCodes = $derived(new Map(stops.map((stop) => [stop.id, stop.code ?? stop.id])));
	const shownCount = (value: number) => searchCount(value, locale);
	const sampleLabel = (value: number) => shownCount(value) + ' ' + tr('stop arrivals', 'passages');
	function measuredLine(mark: RecordMark) {
		return stopLayer ? undefined : line || (mark.lines?.length === 1 ? mark.lines[0] : undefined);
	}
	function corridorReading(mark: RecordMark) {
		const id = measuredLine(mark);
		const names = tr(`${mark.fromName} to ${mark.toName}`, `${mark.fromName} à ${mark.toName}`);
		return id
			? tr(
					`line ${display.lineName(id).number ?? id}, ${names}`,
					`ligne ${display.lineName(id).number ?? id}, ${names}`,
				)
			: names;
	}
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
	const headline = $derived(leader?.value == null ? null : valueText(leader.value));
</script>

{#snippet recordBody(stamp: Snippet | undefined)}
	{#if leader?.value != null}
		<MapPanelAnswer
			value={headline ?? ''}
			sentence={stopLayer
				? tr(
						`is the highest late share of recorded stop arrivals in view, at stop ${leaderStop}, ${leader.name}.`,
						`est la part de passages enregistrés en retard la plus élevée en vue, à l’arrêt ${leaderStop}, ${leader.name}.`,
					)
				: tr(
						`is the most time lost between two stops in view: ${corridorReading(leader)}.`,
						`est le plus grand temps perdu entre deux arrêts en vue\u00a0: ${corridorReading(leader)}.`,
					)}
		/>
	{/if}
	{@render stamp?.()}
	{#if chooseLine}
		<p>
			{tr(
				'Choose a line to see time lost between its stops.',
				'Choisissez une ligne pour voir le temps perdu entre ses arrêts.',
			)}
		</p>
		<Button variant="outline" size="sm" class="min-h-11" onclick={onlinefilters}>
			{tr('Choose a line', 'Choisir une ligne')}
		</Button>
	{:else}
		{#if pending}
			{#key scope}<RecordPending {locale} />{/key}
		{:else if !answer}
			<p role="status">
				{tr('The record is temporarily unavailable.', 'Le bilan est temporairement indisponible.')}
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
				{#if reportCamera}
					<Separator decorative />
					<section
						aria-label={stopLayer
							? tr('Stops in view', 'Arrêts en vue')
							: tr('Corridors in view', 'Corridors en vue')}
						data-slot="map-in-view"
					>
						<div class="flex items-baseline justify-between gap-2">
							<h2 class="map-record-list-title">
								{stopLayer
									? tr('Stops in view', 'Arrêts en vue')
									: tr('Corridors in view', 'Corridors en vue')}
							</h2>
							<span class="tabular-nums text-muted-foreground">{shownCount(visible.length)}</span>
						</div>
						{#if showStopScope}
							<p class="text-muted-foreground">
								{overviewIncludesOtherStops
									? tr(
											'Showing stops served by more than one line, métro and rail stations, and the first and last stops on routes. Zoom in for all stops.',
											'Seuls les arrêts desservis par plusieurs lignes, les stations de métro et de train et les terminus sont affichés. Zoomez pour voir tous les arrêts.',
										)
									: tr(
											'Showing the first and last stops on routes. Zoom in for all stops.',
											'Seuls les terminus sont affichés. Zoomez pour voir tous les arrêts.',
										)}
							</p>
						{:else if drawn !== marks}
							<p class="text-muted-foreground">
								{tr(
									`Showing the ${shownCount(drawn.length)} stretches that lose the most time. Zoom in for all.`,
									`Affichage des ${shownCount(drawn.length)} tronçons où le temps perdu est le plus élevé. Zoomez pour les voir tous.`,
								)}
							</p>
						{/if}
						<ul>
							{#each visible.slice(0, limit) as mark (mark.id)}
								{@const lineId = measuredLine(mark)}
								{@const stopCode = stopCodes.get(mark.stop ?? mark.fromStop ?? '')}
								{@const target = mark.stop ?? lineId}
								<MapPanelRow
									code={lineId
										? (display.lineName(lineId, routeNames.get(lineId)).number ?? lineId)
										: stopCode}
									routePlate={Boolean(lineId)}
									name={stopLayer ? mark.name : (mark.fromName ?? mark.name)}
									href={target ? recordLink(target, mark.direction) : undefined}
									onselect={() => (selectedId = mark.id)}
									detail={stopLayer && mark.sample !== null
										? sampleLabel(mark.sample)
										: mark.toName
											? tr('to', 'à') + ' ' + mark.toName
											: null}
								>
									{#snippet value()}{mark.value !== null
											? valueText(mark.value)
											: stateLabels[mark.state]}{/snippet}
								</MapPanelRow>
							{/each}
						</ul>
						{#if visible.length > limit}
							<Button variant="outline" size="cta-sm" class="min-h-11" onclick={() => (limit += 12)}
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
				<Button variant="ghost" size="sm" class="min-h-11" onclick={() => (selectedId = null)}
					>{tr('Back', 'Retour')}</Button
				>
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
			<a class="record-link text-primary underline" href={recordHref}
				>{stopLayer
					? tr('Stop Record', 'Bilan de l’arrêt')
					: tr('Line Record', 'Bilan de la ligne')}</a
			>
		{/if}
		{#if network && selected?.lines?.length}
			<ul aria-label={tr('Lines serving this segment', 'Lignes qui desservent ce segment')}>
				{#each selected.lines as id (id)}
					<li>
						<a class="record-link text-primary underline" href={recordLink(id)}
							>{display.lineName(id, routeNames.get(id)).label}</a
						>
					</li>
				{/each}
			</ul>
		{/if}
	{/if}
{/snippet}

{#snippet recordContent(stamp: Snippet | undefined)}
	<div class="record-panel">
		{@render recordBody(stamp)}
	</div>
{/snippet}

{@render children(layer === 'live' ? undefined : recordContent, headline)}

<style>
	.record-panel {
		display: grid;
		gap: calc(var(--spacing) * 2);
		color: var(--foreground);
		font-size: var(--text-small);
		line-height: 1.35;
	}
	.record-panel .map-record-list-title {
		font-size: var(--text-control);
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
	label {
		display: grid;
		gap: 0.2rem;
		min-width: 0;
		font-weight: 600;
	}
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
