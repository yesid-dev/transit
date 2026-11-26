<script lang="ts">
	import { untrack } from 'svelte';
	import { FilterSummary, SearchInput, filterCountText } from '@yesid/ui/brand';
	import { Button } from '@yesid/ui/button';
	import type { DataTableColumn } from '@yesid/ui/table';
	import { localizeHref, type Locale } from '#lib/i18n/index.ts';
	import { transitTerms } from '#lib/i18n/transitTerms.copy.ts';
	import { routeFor } from '#lib/nav/index.ts';
	import { routeModeKey } from '#lib/search/stopMode.ts';
	import { carryFrameState, recordStart } from '#lib/site/frameState.ts';
	import { transitDisplay } from '#lib/site/transitDisplayContext.ts';
	import {
		countLabels as countTemplates,
		countedUnit,
		citeDates,
		dateRange,
		lateShare,
		agencyName,
		frenchAgency,
		methodEvidence,
		pageCitation,
		recordPercent,
		recordRatio,
		recordStamp,
		rowSentence,
		tripsRan,
	} from '#lib/site/presenter.ts';
	import type { LinesRecord } from '#lib/server/finderRecord.ts';
	import type { RouteIndexEntry } from '#lib/v1/schemas/routes_index.ts';
	import type { PublicCity } from '#lib/v1/schemas/providers.ts';
	import { overviewCopy } from '../home/overviewRecord.copy.ts';
	import { recordCounts } from '../home/overviewRecord.ts';
	import AboutFigures from '../record/AboutFigures.svelte';
	import RecordActionGroup from '../record/RecordActionGroup.svelte';
	import CiteBlock from '../record/CiteBlock.svelte';
	import RecordAnswer from '../record/RecordAnswer.svelte';
	import RecordCard from '../record/RecordCard.svelte';
	import RecordDataTable from '../record/RecordDataTable.svelte';
	import RecordEvidenceLine from '../record/RecordEvidenceLine.svelte';
	import RecordGroup from '../record/RecordGroup.svelte';
	import RecordScreen from '../record/RecordScreen.svelte';
	import RecordPending from '../record/RecordPending.svelte';
	import RecordSkeleton from '../record/RecordSkeleton.svelte';
	import RecordTableValue from '../record/RecordTableValue.svelte';
	import ScreenTitle from '../record/ScreenTitle.svelte';
	import StateMark from '../record/StateMark.svelte';
	import { finderCsv, finderRecordUrl, type FinderResult } from '../record/finderText.ts';
	import { recordState, recordStateFor } from '../record/recordStates.ts';
	import { lineExclusion } from './linesRecord.ts';
	import {
		choose,
		lastGoodNote,
		lowCoverageText,
		recordConnection,
		tally,
		timingBasis,
	} from '../record/recordText.ts';
	import {
		lineMatches,
		lineQuery,
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
		provider,
		sort,
		setSort,
		setQuery,
	}: {
		locale: Locale;
		url: URL;
		record: LinesRecord;
		routes: RouteIndexEntry[];
		provider: PublicCity | null;
		sort: LineSort;
		setSort: (key: string, toggle: boolean) => void;
		/** Writes the field's text to the address; `replace` keeps typing out of the history. */
		setQuery: (text: string, replace: boolean) => void;
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
	const initialTiming = $derived(timingPending && punctuality === null);
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
				// Every row carries its plate, the route ID when the timetable gives no number.
				plate: { code: number ?? row.id, scheduleOnly: row.noLive },
				detail: display.directory.subtitle(row.id),
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
	// The field narrows the three lists. The answer, evidence and downloads keep every line.
	const appliedQuery = $derived(lineQuery(url.searchParams));
	let query = $state(untrack(() => appliedQuery));
	let typing = $state(false);
	let timer: ReturnType<typeof setTimeout> | undefined;
	$effect(() => {
		const applied = appliedQuery;
		if (!untrack(() => typing) && untrack(() => query.trim()) !== applied) query = applied;
	});
	$effect(() => () => clearTimeout(timer));
	function applyQuery(value: string, replace: boolean) {
		clearTimeout(timer);
		typing = false;
		setQuery(value, replace);
	}
	function queueQuery(value: string) {
		query = value;
		typing = true;
		clearTimeout(timer);
		timer = setTimeout(() => applyQuery(value, true), 250);
	}
	const matching = (row: Row) =>
		lineMatches({ number: row.plate?.code ?? row.number, label: row.label }, appliedQuery);
	const measuredShown = $derived(measured.filter(matching));
	const scheduleShown = $derived(scheduleOnly.filter(matching));
	const excludedShown = $derived(excluded.filter(matching));
	const matchCount = $derived(measuredShown.length + scheduleShown.length + excludedShown.length);
	const countLabels = $derived(
		countTemplates(
			matchCount,
			{
				singular: t('{count} line', '{count} ligne'),
				plural: t('{count} lines', '{count} lignes'),
			},
			locale,
		),
	);
	const noMatch = $derived(
		t(
			'No line in this list matches this number or name.',
			'Aucune ligne de cette liste ne correspond à ce numéro ou à ce nom.',
		),
	);
	const clearHref = $derived.by(() => {
		const next = new URL(url);
		next.searchParams.delete('q');
		return next.pathname + next.search;
	});
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
	<CiteBlock {locale} text={pageCitation(title, record.period, pinned.href, locale)} />
{/snippet}

{#snippet figures()}
	{#if timingEvidence}<CiteBlock
			{locale}
			text={`Transit. ${title}. ${csvTiming}. ${citeDates(record.period, locale)}. ${methodEvidence(timingEvidence, locale)}`}
		/>{/if}
	{#if deliveryEvidence}<CiteBlock
			{locale}
			text={`Transit. ${title}. ${csvTrips}. ${citeDates(record.period, locale)}. ${methodEvidence(deliveryEvidence, locale)}`}
		/>{/if}
{/snippet}

{#snippet actions()}
	{#if punctuality || delivery}
		<RecordActionGroup
			{locale}
			href={pinned.href}
			{files}
			{citation}
			figures={timingEvidence || deliveryEvidence ? figures : undefined}
		/>
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

{#snippet phoneOnTime(row: Row)}
	{#if timingPending}{pendingText}{:else}{recordPercent(row.onTime!, locale)}{/if}
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
	{@const reason = lineExclusion(row.timing)}
	{#if timingPending}{pendingText}
	{:else}
		{@const state = reason.state}
		<StateMark {state} {locale} />
		{#if reason.text}
			<p class="text-muted-foreground">{reason.text[locale]}</p>
		{:else if state === 'too_few_to_judge' && row.timing?.evidence.counts.classified != null}
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

{#snippet lineField()}
	<form
		method="GET"
		action={url.pathname}
		class="mb-3 grid max-w-xl gap-3"
		onsubmit={(event) => {
			event.preventDefault();
			applyQuery(query, false);
		}}
	>
		{#each [...url.searchParams].filter(([key]) => key !== 'q') as [key, value], i (i)}<input
				type="hidden"
				name={key}
				{value}
			/>{/each}
		<SearchInput
			name="q"
			type="search"
			testId="lines-filter-input"
			visibleLabel
			textSize="body"
			label={t('Line number or name', 'Numéro ou nom de ligne')}
			placeholder={t('Line number or name', 'Numéro ou nom de ligne')}
			description={t('The lists narrow as you type.', 'Les listes se précisent pendant la saisie.')}
			value={query}
			oninput={(event) => queueQuery(event.currentTarget.value)}
		/>
		<noscript><Button type="submit" variant="outline">{t('Search', 'Rechercher')}</Button></noscript
		>
	</form>
	<p class="sr-only" role="status">
		{appliedQuery && !typing ? filterCountText(matchCount, countLabels, locale) : ''}
	</p>
	{#if appliedQuery && !typing}
		<div class="mb-3">
			<FilterSummary
				count={matchCount}
				countLabel={countLabels}
				{locale}
				clearLabel={t('Clear filters', 'Effacer les filtres')}
				onClear={() => {
					query = '';
					applyQuery('', false);
				}}
			/>
			<noscript><a href={clearHref}>{t('Clear filters', 'Effacer les filtres')}</a></noscript>
		</div>
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
			<div
				class:invisible={timingPending && !initialTiming}
				inert={timingPending && !initialTiming}
				data-slot="screen-answer"
			>
				{#if initialTiming}
					<RecordSkeleton shape="answer" />
				{:else if spread !== null}
					<RecordAnswer
						{locale}
						time={stamp}
						value={spread}
						sentence={answer}
						evidence={timingEvidence ? { sample: counts ?? '' } : undefined}
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

			<div id="line-performance" class:contents={initialTiming}>
				{#if initialTiming}
					<RecordCard title={measuredTitle} {stamp}>
						{#key record.punctuality}<RecordPending
								shape="listing"
								{locale}
								answer={record.punctuality}
							/>{/key}
					</RecordCard>
				{:else}
					<RecordCard
						title={measuredTitle}
						{stamp}
						interactive={all.length > 0}
						evidence={!timingPending && timingEvidence && measured.length
							? measuredEvidence
							: undefined}
					>
						{#if all.length}{@render lineField()}{/if}
						{#if timingFailure || tripsFailure}
							<p>{recordConnection.unreachable[locale]}</p>
						{/if}
						{#if measuredShown.length}
							<RecordDataTable
								{locale}
								title={measuredTitle}
								rowHeader={lineHeader}
								rows={measuredShown}
								columns={measuredColumns}
								value="onTime"
								sort={sortChoices}
								phone={{
									value: phoneOnTime,
									line: (row) => {
										if (timingPending) return null;
										const counts = row.delivery?.evidence.counts;
										const events = row.timing?.evidence.counts.classified;
										return rowSentence(
											[
												row.detail,
												row.late !== null && lateShare(row.late, locale),
												!tripsPending &&
													row.trips !== null &&
													counts?.ran != null &&
													counts.scheduled != null &&
													tripsRan(counts.ran, counts.scheduled, locale),
												events != null && countedUnit(events, 'event', locale),
												row.timing?.evidence.low_coverage &&
													lowCoverageText(locale).toLocaleLowerCase(locale),
											],
											locale,
										);
									},
								}}
							/>
						{:else if appliedQuery && measured.length}
							<p>{noMatch}</p>
						{:else if timingAnswer}
							<p>{t('No measured lines.', 'Aucune ligne mesurée.')}</p>
						{/if}
						{#if timingPending}
							{#key record.punctuality}<RecordPending {locale} answer={record.punctuality} />{/key}
						{:else if tripsPending}
							{#key record.trips}<RecordPending
									shape={measured.length ? undefined : 'table'}
									{locale}
									answer={record.trips}
								/>{/key}
						{:else if busy}<RecordPending {locale} busy />{/if}
					</RecordCard>
				{/if}
			</div>

			<div id="lines-without-live-data">
				{#if !initialTiming}
					<RecordCard title={noLiveTitle} interactive={scheduleShown.length > 0}>
						{#if scheduleShown.length}
							<p class="mb-2">
								<StateMark state="no_live_data" {locale} hiddenLabel />
								{operator
									? t(
											`${operator} publishes no real-time feed for these lines, so they are listed apart and never ranked.`,
											`${frenchAgency(agencyName(operator, provider)).start} ne publie aucun flux en temps réel pour ces lignes\u00a0: elles sont présentées à part et jamais classées.`,
										)
									: t(
											'The agency publishes no real-time feed for these lines, so they are listed apart and never ranked.',
											'La société de transport ne publie aucun flux en temps réel pour ces lignes\u00a0: elles sont présentées à part et jamais classées.',
										)}
							</p>
							<RecordDataTable
								{locale}
								title={noLiveTitle}
								rowHeader={lineHeader}
								rows={scheduleShown.map((row) => ({
									...row,
									detail:
										row.routeType !== null && routeModeKey(row.routeType)
											? t('Schedule only.', 'Horaire seulement.')
											: undefined,
								}))}
							/>
						{:else if appliedQuery && scheduleOnly.length}
							<p>{noMatch}</p>
						{:else if timingAnswer}
							<p>{t('No lines without live data.', 'Aucune ligne sans données en direct.')}</p>
						{:else if timingFailure}
							<p>{recordConnection.unreachable[locale]}</p>
						{/if}
					</RecordCard>
				{/if}
			</div>

			{#if !initialTiming}
				<RecordCard
					title={excludedTitle}
					{stamp}
					interactive={!timingFailure && !!timingAnswer && excludedShown.length > 0}
					evidence={!timingPending && timingEvidence && excluded.some(({ timing }) => timing)
						? excludedEvidence
						: undefined}
				>
					{#if timingFailure}
						<p>{recordConnection.unreachable[locale]}</p>
					{:else if timingAnswer}
						{#if excludedShown.length}
							<RecordDataTable
								{locale}
								title={excludedTitle}
								rowHeader={lineHeader}
								rows={excludedShown}
								columns={stateColumns}
							/>
						{:else if appliedQuery && excluded.length}
							<p>{noMatch}</p>
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
			{/if}
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
						text: counts ? `${counts}.` : null,
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
						key: 'method',
						label: about.methodRow,
						text: null,
						link: { href: localizeHref('/metrics', locale, record.city), label: about.method },
					},
					{
						key: 'source',
						label: about.source,
						text: operator
							? `${about.feeds(agencyName(operator, provider))} ${about.recordStart(dateRange({ from: recordStart(provider), to: recordStart(provider) }, locale))}`
							: null,
					},
				]}
			/>
		</RecordGroup>
	</div>
</RecordScreen>
