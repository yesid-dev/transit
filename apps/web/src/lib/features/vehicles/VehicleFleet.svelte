<script lang="ts">
	import { isSettled } from '#lib/site/ready.ts';
	import { page } from '$app/state';
	import { goto, replaceState } from '$app/navigation';
	import { onMount, tick, untrack, type Snippet } from 'svelte';
	import { SvelteMap } from 'svelte/reactivity';
	import { FilterSummary, RoutePlate, StatusMark, filterCountText } from '@yesid/ui/brand';
	import { Combobox, type ComboboxOption } from '@yesid/ui/combobox';
	import { StateNotice } from '@yesid/ui/feedback';
	import { ControlsRail, type SurfaceRailContext } from '@yesid/ui/layout';
	import { Skeleton } from '@yesid/ui/skeleton';
	import { ShowMore, type DataTableColumn } from '@yesid/ui/table';
	import type { PageData } from '../../../routes/[[lang=locale]]/vehicles/$types';
	import { getLocale, intl } from '#lib/i18n/index.ts';
	import { frameHref, recordStart } from '#lib/site/frameState.ts';
	import {
		citeDates,
		countLabels as countTemplates,
		countedUnit,
		singularCount,
		agencyName,
		dateRange,
		daysInService,
		didNotReport,
		hoursInService,
		hoursReading,
		lastReport,
		liveDelayLabels,
		liveStatusWords,
		noHeadingNote,
		tickingLiveStamp,
		methodEvidence,
		recordRatio,
		recordStamp,
		relativeReportAge,
		rowSentence,
	} from '#lib/site/presenter.ts';
	import { transitDisplay } from '#lib/site/transitDisplayContext.ts';
	import { foldSearchText } from '#lib/search/normalize.ts';
	import { liveTimingFor } from '#lib/components/map/liveTiming.ts';
	import { notReporting } from '#lib/components/map/vehicleProjection.ts';
	import { liveReader } from '#lib/v1/adapter/index.ts';
	import { createLiveStore } from '#lib/v1/live/store.svelte.ts';
	import { getRoute } from '#lib/v1/repositories/static.ts';
	import { getV1Runtime } from '#lib/v1/runtime.ts';
	import type { RouteFile, Vehicle } from '#lib/v1/schemas/index.ts';
	import { overviewCopy } from '../home/overviewRecord.copy.ts';
	import { countedRecordDays, recordConnection, tally } from '../record/recordText.ts';
	import { recordSectionLinks } from '../record/recordLinks.ts';
	import AboutFigures from '../record/AboutFigures.svelte';
	import AboutLiveFigures from '../record/AboutLiveFigures.svelte';
	import RecordActionGroup from '../record/RecordActionGroup.svelte';
	import CiteBlock from '../record/CiteBlock.svelte';
	import RecordAnswer from '../record/RecordAnswer.svelte';
	import RecordDataTable from '../record/RecordDataTable.svelte';
	import RecordEvidenceLine from '../record/RecordEvidenceLine.svelte';
	import RecordPending from '../record/RecordPending.svelte';
	import RecordUnavailable from '../record/RecordUnavailable.svelte';
	import { pendingBlockSize, type RecordWaiting } from '../record/recordWaiting.ts';
	import RecordTableValue from '../record/RecordTableValue.svelte';
	import ListingScreen from '../listing/ListingScreen.svelte';
	import StateMark from '../record/StateMark.svelte';
	import { fleetPageSize, fleetView, type VehicleFleetAnswer } from './vehicleFleet.ts';
	import FleetLiveAnswer from './FleetLiveAnswer.svelte';
	import { vehicleHref } from './vehicleLinks.ts';
	import { notTracked, sectionTitles } from './vehicleText.ts';

	let { data: incomingData }: { data: PageData } = $props();
	const incoming = $derived({ data: incomingData, location: page.shallow?.url ?? page.url });
	let lastFleet = $state.raw(untrack(() => incoming));
	$effect.pre(() => {
		if (incoming.data.view) lastFleet = incoming;
	});
	// The outgoing listing can still render as navigation hands over the detail data.
	const fleet = $derived(incoming.data.view ? incoming : lastFleet);
	const data = $derived(fleet.data);
	const location = $derived(fleet.location);
	const locale = getLocale();
	const t = (en: string, fr: string) => (locale === 'fr' ? fr : en);
	const display = transitDisplay();
	const about = $derived(overviewCopy[locale]);
	const operator = $derived(data.provider?.labels[locale].operator);
	const liveMode = $derived(data.mode === 'live');
	// A list that came drawn on the server is shown at once; a streamed one when it arrives.
	let streamed = $state.raw<{ seed: unknown; value: VehicleFleetAnswer } | null>(null);
	const result = $derived.by((): VehicleFleetAnswer | null => {
		const answer = data.fleet;
		if (!answer) return null;
		if (isSettled(answer)) return answer;
		return streamed && streamed.seed === answer ? streamed.value : null;
	});
	const untracked = $derived(
		data.provider?.inputs.vehicle_positions === false ||
			data.provider?.inputs.stable_vehicle_ids === false ||
			result?.kind === 'not_tracked',
	);
	const title = $derived(t('Find a vehicle', 'Trouver un véhicule'));
	const url = $derived(new URL(location.href));
	const pinned = $derived(new URL(frameHref(url, { mode: data.mode, period: data.period }), url));
	const view = $derived(liveMode ? fleetView(location.searchParams) : data.view);
	const href = (path: string) => vehicleHref(path, pinned, locale, data.city);

	$effect(() => {
		const answer = data.fleet;
		if (!answer || isSettled(answer)) return;
		let current = true;
		void answer.then((value) => {
			if (current) streamed = { seed: answer, value };
		});
		return () => {
			current = false;
		};
	});
	const record = $derived(result?.kind === 'answer' ? result.answer : null);
	const periodDays = $derived(
		data.period
			? (Date.parse(data.period.to) - Date.parse(data.period.from)) / 86_400_000 + 1
			: null,
	);
	const recordStampProps = $derived(
		data.period ? { kind: 'record' as const, label: recordStamp(data.period, locale) } : undefined,
	);
	const manifest = untrack(() =>
		data.mode === 'live' && !untracked ? data.v1?.manifest : undefined,
	);
	const live = manifest ? createLiveStore(manifest, liveReader, { families: ['vehicles'] }) : null;
	const { clock } = getV1Runtime();
	const health = $derived(live?.familyStates.vehicles.health);
	const cutoff = manifest ? liveTimingFor(manifest).staleCutoffS : undefined;
	// Hold the reporting fleet as it was at capture time while the feed is late.
	const membershipTime = $derived(
		health?.isStale && live?.vehicles ? Date.parse(live.vehicles.generated_utc) : clock.serverNow,
	);
	const reporting = $derived(
		cutoff === undefined
			? []
			: (live?.vehicles?.vehicles ?? []).filter(
					(vehicle) => !notReporting(vehicle, membershipTime, cutoff),
				),
	);
	const reportStamp = $derived(
		live?.vehicles?.generated_utc
			? tickingLiveStamp(new Date(live.vehicles.generated_utc), locale, { late: health?.isStale })
			: undefined,
	);
	const stamp = $derived(liveMode ? reportStamp : recordStampProps);
	onMount(() => {
		live?.start();
		return () => live?.stop();
	});

	const compare = intl.collator(locale, { numeric: true, sensitivity: 'base' }).compare;
	const liveMatches = $derived(
		reporting
			.filter(
				(vehicle) =>
					(!view.line || vehicle.route === view.line) &&
					vehicle.id.toLowerCase().includes(view.query.toLowerCase()),
			)
			.toSorted((a, b) => compare(a.id, b.id)),
	);
	const liveRows = $derived(
		liveMatches.map((vehicle) => ({
			id: vehicle.id,
			label: vehicle.id,
			href: href(`/vehicle/${encodeURIComponent(vehicle.id)}`),
			vehicle,
		})),
	);
	const recordRows = $derived(
		(record?.rows ?? []).map((row) => ({
			...row,
			label: row.id,
			href: href(`/vehicle/${encodeURIComponent(row.id)}`),
		})),
	);
	type LiveRow = (typeof liveRows)[number];
	type RecordRow = (typeof recordRows)[number];
	const routes = new SvelteMap<string, RouteFile | null>();
	$effect(() => {
		if (!manifest) return;
		for (const vehicle of liveMatches.slice(0, view.shown)) {
			if (!vehicle.route || routes.has(vehicle.route)) continue;
			const id = vehicle.route;
			routes.set(id, null);
			void getRoute(id, { manifest })
				.then((route) => routes.set(id, route))
				.catch(() => {});
		}
	});
	// A feed that gives no vehicle a direction gets one sentence under the table,
	// not "Unknown direction" on every row.
	const headings = $derived(reporting.some((vehicle) => vehicle.direction_id != null));
	function direction(vehicle: Vehicle) {
		const route = vehicle.route ? routes.get(vehicle.route) : null;
		const directions =
			route?.directions?.filter((candidate) => candidate.dir === vehicle.direction_id) ?? [];
		const next = directions.find((candidate) =>
			candidate.stops?.some(({ id }) => id === vehicle.next_stop),
		);
		const sign = display.directory.headsign(
			vehicle.route,
			(next ?? (directions.length === 1 ? directions[0] : null))?.headsign,
		);
		return sign ? display.toward(sign, locale) : null;
	}

	const lineOptions = $derived<ComboboxOption[]>(
		[...new Set(reporting.flatMap(({ route }) => (route ? [route] : [])))]
			.map((value) => {
				const label = display.lineName(value).label;
				return { value, label, search: foldSearchText(`${value} ${label}`) };
			})
			.sort((a, b) => compare(a.label, b.label)),
	);
	const reportingOptions = $derived<ComboboxOption[]>([
		{ value: 'reported', label: t('Reported', 'Signalés'), search: t('reported', 'signales') },
		{
			value: 'silent',
			label: t('Did not report', 'Sans signalement'),
			search: t('did not report', 'sans signalement'),
		},
	]);
	const canFilter = $derived(!untracked && (liveMode ? lineOptions.length > 0 : record?.canFilter));

	let searchInput = $state<HTMLInputElement | null>(null);
	let query = $state(untrack(() => view.query));
	let pending = $state(false);
	let timer: ReturnType<typeof setTimeout> | undefined;
	let searchVersion = 0;
	let results = $state<HTMLElement>();
	let nextRow = $state<number | null>(null);
	const liveShown = $derived(Math.min(liveRows.length, view.shown));
	$effect(() => {
		if (
			nextRow === null ||
			pending ||
			(liveMode ? liveShown : recordRows.length) <= nextRow ||
			!results
		)
			return;
		const index = nextRow;
		void tick().then(() => {
			results?.querySelectorAll<HTMLAnchorElement>('tbody a')[index]?.focus();
			nextRow = null;
		});
	});
	$effect(() => {
		if (!pending && untrack(() => query.trim()) !== view.query) query = view.query;
	});
	$effect(() => () => clearTimeout(timer));
	function listingUrl(text: string, filter: string | null, shown = fleetPageSize) {
		const next = new URL(location.href);
		for (const key of ['q', 'route', 'reporting', 'shown']) next.searchParams.delete(key);
		if (text.trim()) next.searchParams.set('q', text.trim());
		if (filter) next.searchParams.set(liveMode ? 'route' : 'reporting', filter);
		if (shown > fleetPageSize) next.searchParams.set('shown', String(shown));
		return next;
	}
	const selectedFilter = $derived(liveMode ? view.line : view.reporting);
	const clearUrl = $derived(listingUrl('', null));
	async function navigate(
		text: string,
		filter: string | null,
		replace = true,
		shown = fleetPageSize,
	) {
		clearTimeout(timer);
		const version = ++searchVersion;
		const next = listingUrl(text, filter, shown);
		const input = searchInput;
		const selection =
			input && document.activeElement === input
				? ([input.selectionStart, input.selectionEnd] as const)
				: null;
		try {
			if (next.href === location.href) return;
			pending = true;
			if (liveMode) replaceState(next, { ...page.state });
			else await goto(next, { replace, reset: false });
			if (
				version === searchVersion &&
				selection &&
				document.activeElement === document.body &&
				searchInput
			) {
				searchInput.focus({ preventScroll: true });
				searchInput.setSelectionRange(...selection);
			}
		} finally {
			if (version === searchVersion) pending = false;
		}
	}
	function queueSearch(value: string) {
		query = value;
		if (liveMode) {
			void navigate(value, selectedFilter);
			return;
		}
		searchVersion++;
		clearTimeout(timer);
		pending = value.trim() !== view.query;
		timer = setTimeout(() => void navigate(value, selectedFilter), 250);
	}
	async function moreRows(count: number) {
		const index = liveMode ? liveShown : recordRows.length;
		nextRow = index;
		await navigate(view.query, selectedFilter, false, index + count);
	}

	const rowShape = $derived<RecordWaiting>({
		shape: 'rows',
		count: view.shown,
		lines: 1,
		lead: 'none',
	});
	const rowHeight = $derived(pendingBlockSize(rowShape));
	const count = $derived(liveMode ? liveRows.length : (record?.total ?? 0));
	const hasListing = $derived(liveMode ? Boolean(live?.vehicles) : Boolean(record));
	const summaryDetail = $derived.by(() => {
		if (liveMode) {
			const known = liveMatches.filter(
				(vehicle) => vehicle.status !== 'unknown' && vehicle.delay_min != null,
			).length;
			const unknown = liveMatches.length - known;
			return t(
				`: delay known for ${tally(known, locale)}, unknown for ${tally(unknown, locale)}.`,
				`\u00a0: retard connu pour ${tally(known, locale)}, inconnu pour ${tally(unknown, locale)}.`,
			);
		}
		if (!record?.reportingCounts) return '.';
		const { reported, didNotReport, unmeasured } = record.reportingCounts;
		const parts = [
			t(
				`${tally(reported, locale)} reported on a trip`,
				`${tally(reported, locale)} avec signalement en trajet`,
			),
			t(
				`${tally(didNotReport, locale)} did not report`,
				`${tally(didNotReport, locale)} sans signalement`,
			),
		];
		if (unmeasured > 0)
			parts.push(
				t(
					`${tally(unmeasured, locale)} without a reading`,
					`${tally(unmeasured, locale)} sans mesure`,
				),
			);
		return `${t(': ', '\u00a0: ')}${parts.join(', ')}.`;
	});
	const countLabels = $derived(
		countTemplates(
			count,
			{
				singular: t('{count} vehicle listed', '{count} véhicule dans la liste') + summaryDetail,
				plural: t('{count} vehicles listed', '{count} véhicules dans la liste') + summaryDetail,
			},
			locale,
		),
	);
	const paging = $derived({
		showing: (shown: number, total: number) =>
			t(
				`Showing ${tally(shown, locale)} of ${tally(total, locale)}`,
				`${tally(shown, locale)} sur ${tally(total, locale)}`,
			),
		more: (count: number) =>
			t(`Show ${tally(count, locale)} more`, `Afficher ${tally(count, locale)} de plus`),
	});
	const subtitle = $derived(
		operator && (liveMode ? reporting.length > 0 : Boolean(record))
			? `${operator}${t(': ', '\u00a0: ')}${countedUnit(liveMode ? reporting.length : record!.fleet, 'vehicle', locale)}`
			: operator,
	);
	const sample = $derived(
		record
			? [
					record.daysInService === null
						? ''
						: `${countedUnit(record.daysInService, 'day', locale)} ${t('in service', 'en service')}`,
					// A trip two vehicles shared counts once for each, so the sum is named for that.
					record.trips === null ? '' : countedUnit(record.trips, 'trip-per-vehicle', locale),
					countedRecordDays(record.evidence, locale),
				]
					.filter(Boolean)
					.join(', ')
			: '',
	);
	const recordColumns = $derived<DataTableColumn<RecordRow>[]>([
		{
			key: 'days',
			header: t('Days in service', 'Jours en service'),
			numeric: true,
			cell: daysCell,
		},
		{ key: 'hours', header: t('Hours', 'Heures'), numeric: true, cell: hoursCell },
		{
			key: 'lines',
			header: t('Lines it ran', 'Lignes desservies'),
			numeric: true,
			cell: linesCell,
		},
		{ key: 'trips', header: t('Trips', 'Trajets'), numeric: true, cell: tripsCell },
	]);
	const liveColumns = $derived<DataTableColumn<LiveRow>[]>([
		{
			key: 'line',
			header: headings ? t('Line and direction', 'Ligne et direction') : t('Line', 'Ligne'),
			cell: lineCell,
		},
		{ key: 'status', header: t('Status', 'État'), cell: statusCell, width: '1%' },
		{
			key: 'report',
			header: t('Last report', 'Dernier signalement'),
			cell: reportCell,
			width: '1%',
		},
	]);
	const archiveLinks = $derived(recordSectionLinks(pinned, 'fleet'));
	// Before the first reading (also while the page is served) the list is loading, not unavailable.
	const liveLoading = $derived(
		!!live && !live.vehicles && live.familyStates.vehicles.phase !== 'failed',
	);
	// While the first rows load, the list keeps the room of a page of rows, so nothing below jumps.
	const waitingForRows = $derived(
		pending || (liveMode ? liveLoading : !result || result.kind === 'busy'),
	);
</script>

{#snippet filters(context: SurfaceRailContext)}
	{@const label = liveMode ? t('Line', 'Ligne') : t('Reporting', 'Signalement')}
	<ControlsRail label={t('Filter', 'Filtrer')}>
		<div class="grid w-full min-w-0 gap-1">
			<p aria-hidden="true" class="text-small text-muted-foreground">{label}</p>
			<Combobox
				options={liveMode ? lineOptions : reportingOptions}
				value={selectedFilter || null}
				onValueChange={(value) => {
					void navigate(query, value, false);
					context.closeSheet();
				}}
				{label}
				placeholder={t('All', liveMode ? 'Toutes' : 'Tous')}
				clearLabel={t('Clear filter', 'Effacer le filtre')}
				emptyLabel={t('No match', 'Aucune correspondance')}
				fold={foldSearchText}
			/>
		</div>
	</ControlsRail>
{/snippet}

{#snippet daysCell(row: RecordRow)}
	{#if row.state === 'not_reporting'}
		<span class="inline-flex min-w-0 items-baseline gap-2 font-semibold"
			><StateMark state="not_reporting" {locale} hiddenLabel />{t(
				'Did not report',
				'Aucun signal',
			)}</span
		>
	{:else}<RecordTableValue
			{locale}
			text={row.days == null
				? null
				: periodDays
					? recordRatio(row.days, tally(periodDays, locale), locale)
					: tally(row.days, locale)}
			state={row.state}
		/>{/if}
{/snippet}
{#snippet hoursCell(row: RecordRow)}{#if row.state !== 'not_reporting'}<RecordTableValue
			{locale}
			text={row.hours == null ? null : hoursReading(row.hours, locale)}
			state={row.state}
		/>{/if}{/snippet}
{#snippet linesCell(row: RecordRow)}{#if row.state !== 'not_reporting'}<RecordTableValue
			{locale}
			text={row.lines == null ? null : tally(row.lines, locale)}
			state={row.state}
		/>{/if}{/snippet}
{#snippet tripsCell(row: RecordRow)}{#if row.state !== 'not_reporting'}<RecordTableValue
			{locale}
			text={row.trips == null ? null : tally(row.trips, locale)}
			state={row.state}
		/>{/if}{/snippet}
{#snippet lineCell({ vehicle }: LiveRow)}
	{#if vehicle.route}
		{@const toward = headings ? direction(vehicle) : null}
		<span class="inline-flex min-w-0 items-baseline gap-2">
			<span class="shrink-0"
				><RoutePlate code={display.lineName(vehicle.route).number ?? vehicle.route} /></span
			>
			{#if toward}<span class="min-w-0 [overflow-wrap:normal]">{toward}</span
				>{:else if headings}<StateMark state="unknown" {locale} />{/if}
		</span>
	{:else}<StateMark state="unknown" {locale} />{/if}
{/snippet}
{#snippet statusCell({ vehicle }: LiveRow)}
	{#if vehicle.status === 'unknown' || vehicle.delay_min == null}<StateMark
			state="delay_unknown"
			{locale}
		/>
	{:else}<StatusMark
			status={vehicle.status}
			{...liveStatusWords(
				vehicle.status,
				liveDelayLabels(locale)[vehicle.status],
				vehicle.delay_min * 60,
				locale,
			)}
			class="@min-[48rem]:flex-nowrap! @min-[48rem]:whitespace-nowrap"
			style="overflow-wrap: normal; word-break: normal"
		/>{/if}
{/snippet}
{#snippet phoneDays(row: RecordRow)}<RecordTableValue
		{locale}
		text={row.days == null ? null : daysInService(row.days, periodDays, locale)}
		state={row.state}
	/>{/snippet}
{#snippet phonePlate({ vehicle }: LiveRow)}{#if vehicle.route}<span
			class="inline-block whitespace-nowrap"
			><RoutePlate code={display.lineName(vehicle.route).number ?? vehicle.route} /></span
		>{/if}{/snippet}
{#snippet reportCell({ vehicle }: LiveRow)}
	{@const report = vehicle.reported_utc || vehicle.updated_utc}
	{#if report && Number.isFinite(Date.parse(report))}<time
			datetime={report}
			class="@min-[38rem]:whitespace-nowrap"
			>{relativeReportAge((clock.serverNow - Date.parse(report)) / 1000, locale)}</time
		>
	{:else}<StateMark state="unknown" {locale} />{/if}
{/snippet}
{#snippet citation()}
	{#if record && data.period}<CiteBlock
			{locale}
			text={`Transit. ${data.seoTitle}. ${sectionTitles.fleet[locale === 'fr' ? 1 : 0]}. ${citeDates(
				data.period,
				locale,
			)}. ${methodEvidence(record.evidence, locale)} ${archiveLinks.share}`}
		/>{/if}
{/snippet}
{#snippet actions()}
	{#if liveMode}<a
			href={href('/map')}
			class="inline-flex min-h-11 items-center text-primary underline">{about.openMap}</a
		>
	{:else if record}<RecordActionGroup
			{locale}
			href={archiveLinks.share}
			files={[{ href: archiveLinks.csv, label: sectionTitles.fleet[locale === 'fr' ? 1 : 0] }]}
			{citation}
		/>{/if}
{/snippet}
{#snippet evidenceFoot()}{#if record}<RecordEvidenceLine
			{locale}
			evidence={record.evidence}
			{sample}
			note={t(
				'Days count dates with a position reported on a trip.',
				'Les jours comptés sont ceux où une position a été signalée pendant un trajet.',
			)}
		/>{/if}{/snippet}

{#snippet lead()}
	{#if liveMode && !untracked}
		<FleetLiveAnswer {locale} pending={liveLoading} withAction embedded>
			<RecordAnswer
				listing
				{locale}
				time={stamp}
				value={live?.vehicles ? tally(reporting.length, locale) : null}
				size="md"
				sentence={live?.vehicles
					? health?.isStale
						? singularCount(reporting.length, locale)
							? t(
									'vehicle in the last capture. Live reports are late.',
									'véhicule dans le dernier relevé. Les signalements en direct sont en retard.',
								)
							: t(
									'vehicles in the last capture. Live reports are late.',
									'véhicules dans le dernier relevé. Les signalements en direct sont en retard.',
								)
						: singularCount(reporting.length, locale)
							? about.reportingOne
							: about.reporting
					: t(
							'Current vehicle activity is unavailable.',
							'L’activité actuelle des véhicules est indisponible.',
						)}
				{actions}
			/>
		</FleetLiveAnswer>
	{:else if untracked}
		<RecordAnswer listing {locale} value={null} state="not_tracked" sentence={notTracked[locale]} />
	{:else if !result || result.kind === 'busy'}
		<RecordPending {locale} shape="answer" busy={result?.kind === 'busy'} />
	{:else}
		<RecordAnswer
			listing
			{locale}
			time={stamp}
			value={record?.fleet ? tally(record.active, locale) : null}
			size="md"
			sentence={record?.fleet
				? singularCount(record.active, locale)
					? t(
							'vehicle reported on a trip on these dates.',
							'véhicule a signalé une position pendant un trajet à ces dates.',
						)
					: t(
							'vehicles reported on a trip on these dates.',
							'véhicules ont signalé une position pendant un trajet à ces dates.',
						)
				: t('Find a vehicle by its number.', 'Trouvez un véhicule par son numéro.')}
			evidence={record
				? {
						sample,
						lastGood: result?.kind === 'answer' && result.lastGood,
					}
				: undefined}
			actions={record ? actions : undefined}
		/>
	{/if}
{/snippet}

{#snippet summary()}
	{#if waitingForRows || hasListing}
		<div class="fleet-summary" data-slot="fleet-summary">
			{#if waitingForRows}
				<Skeleton class="h-3 w-64 max-w-full" />
			{:else}
				<FilterSummary
					{count}
					countLabel={countLabels}
					{locale}
					clearLabel={t('Clear filters', 'Effacer les filtres')}
					canClear={Boolean(view.query || selectedFilter)}
					onClear={() => {
						query = '';
						void navigate('', null, false);
					}}
				/>
				{#if view.query || selectedFilter}<noscript
						><a href={clearUrl.pathname + clearUrl.search}
							>{t('Clear filters', 'Effacer les filtres')}</a
						></noscript
					>{/if}
			{/if}
		</div>
	{/if}
{/snippet}

{#snippet more()}
	<ShowMore
		shown={liveMode ? liveShown : recordRows.length}
		total={count}
		pageSize={fleetPageSize}
		labels={paging}
		onMore={(value) => void moreRows(value)}
	/>
{/snippet}

{#snippet fleetRows(moreAction: Snippet | undefined)}
	{#if untracked}
		<div class="grid gap-3">
			<p>
				{t(
					'Individual vehicles cannot be followed across dates or compared in the vehicle rankings.',
					'Le suivi des véhicules d’une date à l’autre et leur comparaison dans les classements sont indisponibles.',
				)}
			</p>
			<p>
				{t(
					'The live map and the records for lines and stops are still available.',
					'La carte en direct et les bilans des lignes et des arrêts restent disponibles.',
				)}
			</p>
			<a href={href('/map')} class="inline-flex min-h-11 items-center text-primary underline"
				>{about.openMap}</a
			>
		</div>
	{:else}
		<section
			id={liveMode ? 'vehicles-live' : 'fleet'}
			aria-label={title}
			class="fleet-results min-w-0"
			class:record-fleet-results={!liveMode}
			data-reserved={waitingForRows || count === 0 || count >= view.shown ? '' : undefined}
			style:--fleet-rows-wide={rowHeight?.wide}
			style:--fleet-rows-phone={rowHeight?.phone}
			bind:this={results}
		>
			{#if waitingForRows}
				{#key data.fleet}<RecordPending
						{locale}
						answer={data.fleet}
						shape={rowShape}
						busy={!liveMode && result?.kind === 'busy'}
					/>{/key}
			{:else if liveMode && !live?.vehicles}
				<p role="status">
					{t(
						'Live reports are temporarily unavailable.',
						'Les signalements en direct sont temporairement indisponibles.',
					)}
				</p>
			{:else if !liveMode && result?.kind === 'unreachable'}
				<RecordUnavailable {locale} retry={'retry' in result ? result.retry : undefined} />
			{:else if !liveMode && result && result.kind !== 'answer' && result.kind !== 'not_tracked'}
				<p role="status">{recordConnection[result.kind][locale]}</p>
			{:else if !count}
				<StateNotice
					presentation="frameless"
					role="status"
					title={view.query
						? t('No matching vehicle number.', 'Aucun numéro de véhicule correspondant.')
						: t('No vehicles in this view.', 'Aucun véhicule dans cette vue.')}
				/>
			{:else if liveMode}
				<p>
					{t(
						'Delay unknown means the last report did not give an offset from the timetable.',
						'Un retard inconnu signifie que le dernier signalement ne donnait aucun écart à l’horaire.',
					)}
				</p>
				<RecordDataTable
					{locale}
					{title}
					rowHeader={t('Vehicle', 'Véhicule')}
					compactName
					columns={liveColumns}
					rows={liveRows.slice(0, liveShown)}
					value="status"
					pageSize={0}
					phone={{
						after: phonePlate,
						line: ({ vehicle }) => {
							const toward = vehicle.route && headings ? direction(vehicle) : null;
							const report = vehicle.reported_utc || vehicle.updated_utc;
							return rowSentence(
								[
									toward,
									report &&
										Number.isFinite(Date.parse(report)) &&
										lastReport(
											relativeReportAge((clock.serverNow - Date.parse(report)) / 1000, locale),
											locale,
										),
								],
								locale,
							);
						},
					}}
				/>
				{@render moreAction?.()}
				{#if !headings && operator}<p class="text-small text-muted-foreground">
						{noHeadingNote(agencyName(operator, page.data.provider), locale)}
					</p>{/if}
			{:else}
				<RecordDataTable
					{locale}
					title={sectionTitles.fleet[locale === 'fr' ? 1 : 0]}
					rowHeader={t('Vehicle', 'Véhicule')}
					compactName
					columns={recordColumns}
					rows={recordRows}
					value="days"
					pageSize={0}
					phone={{
						value: phoneDays,
						empty: (row) => row.state === 'not_reporting',
						line: (row) =>
							row.state === 'not_reporting'
								? didNotReport(locale)
								: rowSentence(
										[
											row.hours != null && hoursInService(row.hours, locale),
											row.lines != null && countedUnit(row.lines, 'line', locale),
											row.trips != null && countedUnit(row.trips, 'trip', locale),
										],
										locale,
									),
					}}
				/>
				{@render moreAction?.()}
				{#if recordRows.some(({ state }) => state === 'not_reporting')}<p>
						{t(
							'Did not report on these dates. That is not the same as out of service.',
							'Aucun signalement pour ces dates. Cela ne veut pas dire que le véhicule était hors service.',
						)}
					</p>{/if}
			{/if}
		</section>
	{/if}
{/snippet}

{#snippet methodology()}
	{#if liveMode}<AboutLiveFigures
			{locale}
			{operator}
			healthLink={href('/status')}
			captureAge={health?.ageSeconds}
		/>
	{:else}
		<AboutFigures
			title={about.about}
			compact
			fields={[
				{
					key: 'period',
					label: about.period,
					text: data.period ? dateRange(data.period, locale) : null,
				},
				{
					key: 'counted',
					label: about.counted,
					text: t(
						'A day in service requires a position reported on a trip.',
						'Un jour en service exige une position signalée pendant un trajet.',
					),
				},
				{
					key: 'observed',
					label: about.observed,
					text: record?.coverageNote?.[locale] ?? null,
				},
				{
					key: 'method',
					label: about.methodRow,
					text: null,
					link: { href: href('/metrics'), label: about.method },
				},
				{
					key: 'error',
					label: t('Seen an error?', 'Vous avez vu une erreur?'),
					text: null,
					link: {
						href: href('/metrics') + '#about-transit',
						label: t('About Transit', 'À propos de Transit'),
					},
				},
				{
					key: 'source',
					label: about.source,
					text: operator
						? `${about.feeds(agencyName(operator, page.data.provider))} ${about.recordStart(dateRange({ from: recordStart(page.data.provider), to: recordStart(page.data.provider) }, locale))}`
						: null,
				},
			]}
		/>
	{/if}
{/snippet}

<ListingScreen
	{locale}
	head={{ title: data.seoTitle, subtitle }}
	answer={lead}
	filters={canFilter ? filters : undefined}
	title={untracked
		? t('What changes without vehicle numbers', 'Ce qui change sans numéro de véhicule')
		: title}
	titleAside={untracked ? undefined : stamp}
	search={untracked
		? undefined
		: {
				url: location,
				exclude: ['shown'],
				value: query,
				label: t('Vehicle number', 'Numéro de véhicule'),
				placeholder: t('Vehicle number', 'Numéro de véhicule'),
				description: t('The number painted on the vehicle.', 'Le numéro inscrit sur le véhicule.'),
				onInput: queueSearch,
				onSubmit: () => void navigate(query, selectedFilter, false),
			}}
	bind:searchInput
	{summary}
	resultCountText={waitingForRows || !hasListing ? '' : filterCountText(count, countLabels, locale)}
	children={fleetRows}
	{more}
	about={untracked ? undefined : methodology}
	card={{
		class:
			!untracked &&
			!liveMode &&
			!view.query &&
			!selectedFilter &&
			(waitingForRows || count >= fleetPageSize)
				? 'max-sm:min-h-[126.625rem] lg:min-h-[100.125rem]'
				: undefined,
		stampRule: !untracked,
		stampPending: !untracked && liveMode && liveLoading,
		evidence: !untracked && !liveMode ? evidenceFoot : undefined,
	}}
/>

<style>
	.fleet-summary {
		min-block-size: 1lh;
	}

	.fleet-results[data-reserved] {
		min-block-size: var(--fleet-rows-wide);
	}
	@media (width < 40rem) {
		.fleet-summary {
			min-block-size: 2lh;
		}

		.record-fleet-results {
			/* Phone rows include the secondary vehicle facts and their touch target. */
			--record-waiting-row-height: 5.25rem;
		}

		.fleet-results[data-reserved] {
			min-block-size: var(--fleet-rows-phone);
		}
	}
</style>
