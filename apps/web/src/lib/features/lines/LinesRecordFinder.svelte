<script lang="ts">
	import type { DataTableColumn } from '@yesid/ui/table';
	import { DashboardGrid } from '@yesid/ui/layout';
	import { localizeHref, type Locale } from '#lib/i18n/index.ts';
	import { transitTerms } from '#lib/i18n/transitTerms.copy.ts';
	import { routeFor } from '#lib/nav/index.ts';
	import { routeModeKey } from '#lib/search/stopMode.ts';
	import { carryFrameState, RECORD_START } from '#lib/site/frameState.ts';
	import { transitDisplay } from '#lib/site/transitDisplayContext.ts';
	import {
		countedUnit,
		dateRange,
		methodEvidence,
		recordPercent,
		recordRatio,
		recordStamp,
	} from '#lib/site/presenter.ts';
	import type { LinesRecord } from '#lib/server/finderRecord.ts';
	import type { ScheduleEdition } from '#lib/search/searchIndex.ts';
	import type { RouteIndexEntry } from '#lib/v1/schemas/routes_index.ts';
	import type { PublicCity } from '#lib/v1/schemas/providers.ts';
	import { overviewCopy } from '../home/overviewRecord.copy.ts';
	import { recordCounts } from '../home/overviewRecord.ts';
	import AboutFigures from '../record/AboutFigures.svelte';
	import RecordActionGroup from '../record/RecordActionGroup.svelte';
	import RecordAnswer from '../record/RecordAnswer.svelte';
	import RecordCard from '../record/RecordCard.svelte';
	import RecordDataTable from '../record/RecordDataTable.svelte';
	import RecordEvidenceLine from '../record/RecordEvidenceLine.svelte';
	import RecordGroup from '../record/RecordGroup.svelte';
	import RecordScreen from '../record/RecordScreen.svelte';
	import RecordPending from '../record/RecordPending.svelte';
	import RecordTableValue from '../record/RecordTableValue.svelte';
	import ScreenTitle from '../record/ScreenTitle.svelte';
	import StateMark from '../record/StateMark.svelte';
	import { finderCsv, finderRecordUrl, type FinderResult } from '../record/finderText.ts';
	import { recordState, recordStateFor } from '../record/recordStates.ts';
	import {
		choose,
		lastGoodNote,
		lowCoverageText,
		pooledDays,
		punctualityWeighting,
		recordConnection,
		tally,
		timingBasis,
	} from '../record/recordText.ts';
	import {
		lineRecordRows,
		lineSpread,
		observedLineReadings,
		orderedLines,
		type LineSort,
	} from './linesRecord.ts';

	let {
		locale,
		url,
		record,
		routes,
		directions,
		provider,
		sort,
		setSort,
	}: {
		locale: Locale;
		url: URL;
		record: LinesRecord;
		routes: RouteIndexEntry[];
		directions?: ScheduleEdition['route_directions'];
		provider: PublicCity | null;
		sort: LineSort;
		setSort: (key: string, toggle: boolean) => void;
	} = $props();

	const t = (en: string, fr: string) => choose(locale, en, fr);
	const display = transitDisplay();
	const terms = $derived(transitTerms[locale]);
	const about = $derived(overviewCopy[locale]);
	const operator = $derived(provider?.labels[locale].operator);
	const title = $derived(t('Lines', 'Lignes'));
	const measuredTitle = $derived(t('Every measured line', 'Toutes les lignes mesurées'));
	const noLiveTitle = $derived(t('Lines without live data', 'Lignes sans données en direct'));
	const excludedTitle = $derived(
		t('Lines that cannot be judged on these dates', 'Lignes impossibles à évaluer pour ces dates'),
	);
	const noReading = $derived(
		t(
			'No lines can be measured on these dates.',
			'Aucune ligne ne peut être mesurée pour ces dates.',
		),
	);
	const lineHeader = $derived(terms.line);
	const lateHeader = $derived(terms.band.late);
	const tripsHeader = $derived(t('Trips that ran', 'Trajets effectués'));
	const eventsHeader = $derived(t('Stop events', 'Passages aux arrêts'));
	const statusHeader = $derived(t('Status', 'État'));
	const stamp = $derived({ kind: 'record' as const, label: recordStamp(record.period, locale) });
	const pinned = $derived(finderRecordUrl(url, record.city, record.period));
	const sortChoices = $derived({
		key: sort.key === 'line' ? 'name' : sort.key,
		direction: sort.direction,
		onSort: (key: string) => setSort(key === 'name' ? 'line' : key, true),
		choices: {
			onSelect: (key: string) => setSort(key === 'name' ? 'line' : key, false),
			options: [
				{ key: 'name', label: t('Line number', 'Numéro de ligne') },
				{ key: 'onTime', label: t('On-time share', 'Part à l’heure') },
				{ key: 'late', label: t('Late share', 'Part en retard') },
				{ key: 'trips', label: tripsHeader },
			],
		},
	});

	let punctuality = $state.raw<FinderResult | null>(null);
	let delivery = $state.raw<FinderResult | null>(null);
	let timingPending = $state(true);
	let tripsPending = $state(true);
	let readingCity: string | null = null;
	const pendingText = $derived(t('Calculating…', 'Calcul en cours…'));
	$effect(() => {
		const { punctuality: timing, trips, city } = record;
		let current = true;
		let nextDelivery: FinderResult | null = null;
		// Keep the previous row set and answer height for same-city period changes.
		if (readingCity !== city) {
			punctuality = null;
			delivery = null;
		}
		readingCity = city;
		timingPending = true;
		tripsPending = true;
		void timing.then((answer) => {
			if (!current) return;
			punctuality = answer;
			delivery = nextDelivery;
			timingPending = false;
		});
		void trips.then((answer) => {
			if (!current) return;
			nextDelivery = answer;
			tripsPending = false;
			if (!timingPending) delivery = answer;
		});
		return () => {
			current = false;
		};
	});

	function endpoints(id: string): string | undefined {
		const heads = [
			...new Set(
				directions?.[id]
					?.map(({ headsign }) => display.directionName(headsign, locale))
					.filter(Boolean),
			),
		];
		return heads.length === 2
			? t(`${heads[0]} to ${heads[1]}`, `${heads[0]} à ${heads[1]}`)
			: heads[0];
	}

	const all = $derived(
		lineRecordRows(routes, provider, punctuality, delivery, locale).map((row) => {
			const { number, name, label } = display.lineName(row.id);
			return {
				...row,
				href: carryFrameState(
					localizeHref(routeFor({ kind: 'line', id: row.id }), locale, record.city),
					pinned,
				),
				label: name ?? label,
				plate: number ? { code: number, scheduleOnly: row.noLive } : undefined,
				detail: endpoints(row.id),
			};
		}),
	);
	type Row = (typeof all)[number];

	const scheduleOnly = $derived(all.filter((row) => row.noLive));
	const measured = $derived(
		orderedLines(
			all.filter((row) => !row.noLive && row.onTime !== null),
			sort,
			locale,
		),
	);
	const excluded = $derived(
		all
			.filter((row) => !row.noLive && row.onTime === null)
			.map((row) => ({ ...row, detail: undefined })),
	);
	const spread = $derived(lineSpread(measured, locale));
	const answer = $derived(
		measured.length === 1
			? t(
					'is the on-time share for the one line that can be measured on these dates.',
					'est la part à l’heure de la seule ligne qui peut être mesurée pour ces dates.',
				)
			: t(
					`is the spread of on-time share across the ${tally(measured.length, locale)} lines that can be measured on these dates.`,
					`est la plage des parts à l’heure pour les ${tally(measured.length, locale)} lignes qui peuvent être mesurées pour ces dates.`,
				),
	);
	const timingAnswer = $derived(punctuality?.kind === 'answer' ? punctuality.answer : null);
	const timingFailure = $derived(
		!timingPending && punctuality && punctuality.kind !== 'answer' && punctuality.kind !== 'busy',
	);
	const tripsFailure = $derived(
		!timingPending &&
			!tripsPending &&
			delivery &&
			delivery.kind !== 'answer' &&
			delivery.kind !== 'busy',
	);
	const busy = $derived(
		(!timingPending && punctuality?.kind === 'busy') ||
			(!timingPending && !tripsPending && delivery?.kind === 'busy'),
	);
	const minimum = $derived(
		timingAnswer?.info?.find(({ id }) => id === 'on_time')?.minimum_sample ??
			timingAnswer?.info?.[0]?.minimum_sample,
	);
	const timingEvidence = $derived(timingAnswer?.evidence);
	const deliveryEvidence = $derived(
		delivery?.kind === 'answer' ? delivery.answer.evidence : undefined,
	);

	// Keep the established headings, row order, values and filenames in the downloads.
	const csvTiming = $derived(t('On-time share', 'Part à l’heure'));
	const csvTrips = $derived(t('Trips run of scheduled', 'Trajets effectués sur prévus'));
	const sources = $derived(
		[timingEvidence, deliveryEvidence].filter((source) => source !== undefined),
	);
	const csvHeaders = $derived([
		t('Line ID', 'Identifiant de la ligne'),
		lineHeader,
		csvTiming,
		t('Late share', 'Part en retard'),
		t('Trips run', 'Trajets effectués'),
		t('Scheduled trips', 'Trajets prévus'),
		t('Classified stop events', 'Passages classés'),
		t('On-time events', 'Passages à l’heure'),
		t('Late events', 'Passages en retard'),
		t('Punctuality status', 'État de la ponctualité'),
		t('Trip status', 'État des trajets'),
	]);
	const legacySchedule = $derived(
		all.filter(
			(row) =>
				(row.timing?.state ?? row.delivery?.state) === 'no_live_data' ||
				(!row.timing && !row.delivery && row.noLive),
		),
	);
	const legacyMeasured = $derived(all.filter((row) => !legacySchedule.includes(row)));
	function file(
		section: string,
		label: string,
		headers: string[],
		rows: (string | number | null)[][],
	) {
		return {
			label,
			href: finderCsv(headers, rows, locale, record.city, record.period, sources),
			download: `${section}-${record.period.from}-${record.period.to}.csv`,
		};
	}
	const files = $derived([
		...(punctuality && delivery && legacyMeasured.length
			? [
					file(
						'line-performance',
						t('Line performance', 'Performance des lignes'),
						csvHeaders,
						legacyMeasured.map(({ csv }) => csv),
					),
				]
			: []),
		...(legacySchedule.length
			? [
					file(
						'lines-without-live-data',
						noLiveTitle,
						[lineHeader, statusHeader],
						legacySchedule.map(({ name }) => [name.label, recordState('no_live_data')[locale]]),
					),
				]
			: []),
	]);

	const measuredColumns = $derived<DataTableColumn<Row>[]>([
		{
			key: 'onTime',
			header: about.onTime,
			sortable: true,
			numeric: true,
			width: '16ch',
			cell: onTimeCell,
		},
		{
			key: 'late',
			header: lateHeader,
			sortable: true,
			numeric: true,
			width: locale === 'fr' ? '16ch' : '12ch',
			cell: lateCell,
		},
		{
			key: 'trips',
			header: tripsHeader,
			sortable: true,
			numeric: true,
			width: locale === 'fr' ? '27ch' : '28ch',
			cell: tripsCell,
		},
		{
			key: 'events',
			header: eventsHeader,
			numeric: true,
			width: locale === 'fr' ? 'min(24ch, 100cqi)' : 'min(17ch, 100cqi)',
			cell: eventsCell,
		},
	]);
	const stateColumns = $derived<DataTableColumn<Row>[]>([
		{ key: 'status', header: statusHeader, cell: stateCell },
	]);
	const totals = $derived(
		measured.reduce(
			(acc, row) => ({
				events: acc.events + (row.timing?.evidence.counts.classified ?? 0),
				trips:
					row.trips === null
						? acc.trips
						: (acc.trips ?? 0) + (row.delivery?.evidence.counts.ran ?? 0),
			}),
			{ events: 0, trips: null as number | null },
		),
	);
	const days = $derived(
		timingEvidence?.days_included.length
			? countedUnit(timingEvidence.days_included.length, 'day', locale)
			: '',
	);
	const counts = $derived(
		measured.length ? recordCounts(totals.events, totals.trips, days, locale) : null,
	);
	const observed = $derived(
		timingBasis(
			measured.reduce<Record<string, number>>((total, row) => {
				for (const [key, value] of Object.entries(row.timing?.evidence.counts ?? {})) {
					if (value !== null) total[key] = (total[key] ?? 0) + value;
				}
				return total;
			}, {}),
			locale,
		),
	);
	const observation = $derived(
		observedLineReadings(measured.flatMap(({ timing }) => (timing ? [timing.evidence] : []))),
	);

	const subtitle = $derived.by(() => {
		if (!routes.length) return undefined;
		const count = countedUnit(routes.length, 'line', locale);
		return operator ? `${operator}${locale === 'fr' ? '\u00a0' : ''}: ${count}` : count;
	});
</script>

{#snippet citation()}
	<p>Transit. {title}. {dateRange(record.period, locale)}.</p>
	{#if timingEvidence}<p>{csvTiming}. {methodEvidence(timingEvidence, locale)}</p>{/if}
	{#if deliveryEvidence}<p>{csvTrips}. {methodEvidence(deliveryEvidence, locale)}</p>{/if}
	<p>
		<a class="inline-flex min-h-11 items-center text-primary underline" href={pinned.href}
			>{t('Link to this view', 'Lien vers cette vue')}</a
		>
	</p>
{/snippet}

{#snippet actions()}
	{#if punctuality || delivery}
		<RecordActionGroup {locale} href={pinned.href} {files} {citation} />
	{/if}
{/snippet}

{#snippet onTimeCell(row: Row)}
	{#if timingPending}{pendingText}
	{:else}
		<strong class="text-base">{recordPercent(row.onTime!, locale)}</strong>
		{#if row.timing?.evidence.low_coverage}<small class="block text-muted-foreground"
				>{lowCoverageText(locale)}</small
			>{/if}
	{/if}
{/snippet}

{#snippet lateCell(row: Row)}
	<RecordTableValue
		{locale}
		text={timingPending ? pendingText : row.late === null ? null : recordPercent(row.late, locale)}
	/>
{/snippet}

{#snippet tripsCell(row: Row)}
	{@const counts = row.delivery?.evidence.counts}
	<RecordTableValue
		{locale}
		text={tripsPending || timingPending
			? pendingText
			: row.trips === null
				? tripsFailure
					? t('Unavailable', 'Indisponible')
					: null
				: recordRatio(counts!.ran!, tally(counts!.scheduled!, locale), locale)}
		state={recordStateFor(row.delivery?.state)}
	/>
{/snippet}

{#snippet eventsCell(row: Row)}
	{@const count = row.timing?.evidence.counts.classified}
	<RecordTableValue
		{locale}
		text={timingPending ? pendingText : count == null ? null : tally(count, locale)}
	/>
{/snippet}

{#snippet stateCell(row: Row)}
	{@const state = recordStateFor(row.timing?.state)}
	{#if timingPending}{pendingText}
	{:else}
		<StateMark {state} {locale} />
		{#if state === 'too_few_to_judge' && row.timing?.evidence.counts.classified != null}
			<p class="text-muted-foreground">
				{countedUnit(row.timing.evidence.counts.classified, 'event', locale)}{minimum == null
					? '.'
					: t(
							`, the minimum is ${tally(minimum, locale)}.`,
							`, sur un minimum de ${tally(minimum, locale)}.`,
						)}
			</p>
		{:else if row.timing?.evidence.coverage_reason === 'insufficient_coverage'}
			<p class="text-muted-foreground">
				{t(
					'There were too few readings to cover the scheduled stops.',
					'Il y avait trop peu de relevés pour couvrir les arrêts prévus.',
				)}
			</p>
		{:else if row.timing?.state_text[locale] && row.timing.state_text[locale] !== recordState(state)[locale]}
			<p class="text-muted-foreground">{row.timing.state_text[locale]}</p>
		{/if}
	{/if}
{/snippet}

{#snippet measuredEvidence()}
	{#if timingEvidence}<RecordEvidenceLine {locale} evidence={timingEvidence} sample={counts} />{/if}
{/snippet}

{#snippet excludedEvidence()}
	{#if timingEvidence}<RecordEvidenceLine {locale} evidence={timingEvidence} />{/if}
{/snippet}

<RecordScreen class="min-w-0">
	<RecordGroup><ScreenTitle {title} {subtitle} /></RecordGroup>
	<div class="min-w-0" data-slot="screen-content">
		<RecordGroup density="compact">
			<div class:invisible={timingPending} inert={timingPending} data-slot="screen-answer">
				{#if spread !== null}
					<RecordAnswer
						{locale}
						time={stamp}
						value={spread}
						sentence={answer}
						evidence={timingEvidence ? { sample: counts ?? '', record: timingEvidence } : undefined}
						{actions}
					/>
				{:else if punctuality && punctuality.kind !== 'busy'}
					<RecordAnswer
						{locale}
						time={stamp}
						value={null}
						sentence={timingFailure ? recordConnection.unreachable[locale] : noReading}
						state={timingFailure ? undefined : 'not_measured'}
						{actions}
					/>
				{/if}
			</div>

			<div id="line-performance">
				<RecordCard
					title={measuredTitle}
					{stamp}
					interactive={measured.length > 0}
					evidence={!timingPending && timingEvidence && measured.length
						? measuredEvidence
						: undefined}
				>
					{#if timingFailure || tripsFailure}
						<p>{recordConnection.unreachable[locale]}</p>
					{/if}
					{#if measured.length}
						<RecordDataTable
							{locale}
							title={measuredTitle}
							rowHeader={lineHeader}
							rows={measured}
							columns={measuredColumns}
							value="onTime"
							sort={sortChoices}
						/>
					{:else if timingAnswer}
						<p>{t('No measured lines.', 'Aucune ligne mesurée.')}</p>
					{/if}
					{#if timingPending}
						{#key record.punctuality}<RecordPending {locale} answer={record.punctuality} />{/key}
					{:else if tripsPending}
						{#key record.trips}<RecordPending {locale} answer={record.trips} />{/key}
					{:else if busy}<RecordPending {locale} busy />{/if}
				</RecordCard>
			</div>

			<DashboardGrid gutter={false} minTile="22rem">
				<div id="lines-without-live-data">
					<RecordCard title={noLiveTitle} interactive={scheduleOnly.length > 0}>
						{#if scheduleOnly.length}
							<p class="mb-2">
								<StateMark state="no_live_data" {locale} hiddenLabel />
								{operator
									? t(
											`${operator} publishes no real-time feed for these lines. These lines are listed apart and never ranked.`,
											`${operator} ne publie aucun flux en temps réel pour ces lignes. Ces lignes sont présentées à part et ne sont jamais classées.`,
										)
									: t(
											'The agency publishes no real-time feed for these lines. These lines are listed apart and never ranked.',
											'L’agence ne publie aucun flux en temps réel pour ces lignes. Ces lignes sont présentées à part et ne sont jamais classées.',
										)}
							</p>
							<RecordDataTable
								{locale}
								title={noLiveTitle}
								rowHeader={lineHeader}
								rows={scheduleOnly.map((row) => ({
									...row,
									detail:
										row.routeType !== null && routeModeKey(row.routeType)
											? t('Schedule only.', 'Horaire seulement.')
											: undefined,
								}))}
							/>
						{:else if timingAnswer}
							<p>{t('No lines without live data.', 'Aucune ligne sans données en direct.')}</p>
						{:else if timingFailure}
							<p>{recordConnection.unreachable[locale]}</p>
						{/if}
					</RecordCard>
				</div>

				<RecordCard
					title={excludedTitle}
					{stamp}
					interactive={!timingFailure && !!timingAnswer && excluded.length > 0}
					evidence={!timingPending && timingEvidence && excluded.some(({ timing }) => timing)
						? excludedEvidence
						: undefined}
				>
					{#if timingFailure}
						<p>{recordConnection.unreachable[locale]}</p>
					{:else if timingAnswer}
						{#if excluded.length}
							<RecordDataTable
								{locale}
								title={excludedTitle}
								rowHeader={lineHeader}
								rows={excluded}
								columns={stateColumns}
							/>
						{:else}
							<p>
								{t(
									'No lines were left out for these dates.',
									'Aucune ligne n’a été écartée pour ces dates.',
								)}
							</p>
						{/if}
					{/if}
				</RecordCard>
			</DashboardGrid>
		</RecordGroup>

		<RecordGroup class={timingPending ? 'invisible' : undefined} inert={timingPending}>
			<AboutFigures
				title={about.about}
				compact
				fields={[
					{ key: 'period', label: about.period, text: dateRange(record.period, locale) },
					{
						key: 'counted',
						label: about.counted,
						text: counts
							? [
									counts + '.',
									punctualityWeighting[locale],
									record.period.from !== record.period.to ? pooledDays[locale] : '',
								]
									.filter(Boolean)
									.join(' ')
							: null,
					},
					{
						key: 'observed',
						label: about.observed,
						text: [
							observation
								? about.observedShare(
										recordPercent(observation.share, locale),
										observation.scheduled === undefined
											? undefined
											: tally(observation.scheduled, locale),
									)
								: '',
							observed,
							timingAnswer?.coverage_note?.[locale],
							delivery?.kind === 'answer' ? delivery.answer.coverage_note?.[locale] : '',
							(punctuality?.kind === 'answer' && punctuality.lastGood) ||
							(delivery?.kind === 'answer' && delivery.lastGood)
								? lastGoodNote[locale]
								: '',
						]
							.filter(Boolean)
							.join(' '),
					},
					{ key: 'means', label: about.means, text: about.definition },
					{
						key: 'versions',
						label: about.versions,
						text: sources.length
							? [...new Set(sources.map((evidence) => methodEvidence(evidence, locale)))].join(' ')
							: null,
					},
					{
						key: 'source',
						label: about.source,
						text: operator
							? `${about.feeds(operator)} ${about.recordStart(dateRange({ from: RECORD_START, to: RECORD_START }, locale))}`
							: null,
					},
				]}
				versionsLink={{ href: localizeHref('/metrics', locale, record.city), label: about.method }}
			/>
		</RecordGroup>
	</div>
</RecordScreen>
