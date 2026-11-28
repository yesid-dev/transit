<script lang="ts">
	import { tick, untrack } from 'svelte';
	import { FilterSummary, filterCountText } from '@yesid/ui/brand';
	import { StateNotice } from '@yesid/ui/feedback';
	import { Skeleton } from '@yesid/ui/skeleton';
	import type { DataTableColumn } from '@yesid/ui/table';
	import { localizeHref, type Locale } from '#lib/i18n/index.ts';
	import { transitTerms } from '#lib/i18n/transitTerms.copy.ts';
	import { routeFor } from '#lib/nav/index.ts';
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
		citationSource,
		pageCitation,
		recordPercent,
		recordRatio,
		recordStamp,
		rowSentence,
		tripsRan,
	} from '#lib/site/presenter.ts';
	import type { LinesRecord } from '#lib/server/finderRecord.ts';
	import { isSettled, type Ready } from '#lib/site/ready.ts';
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
	import RecordPending from '../record/RecordPending.svelte';
	import RecordTableValue from '../record/RecordTableValue.svelte';
	import ListingScreen from '../listing/ListingScreen.svelte';
	import ListingSort from '../listing/ListingSort.svelte';
	import StateMark from '../record/StateMark.svelte';
	import { finderCsv, finderRecordUrl, type FinderResult } from '../record/finderText.ts';
	import { recordState, recordStateFor } from '../record/recordStates.ts';
	import {
		belowRankingFloor,
		lineExclusion,
		lineHold,
		lineHoldText,
		type LineHold,
	} from './linesRecord.ts';
	import {
		choose,
		countedRecordDays,
		lastGoodNote,
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
		record: Ready<LinesRecord>;
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
	const tooFew = $derived(t('Too few to judge', 'Trop peu pour juger'));
	let settledPeriod = $state.raw<LinesRecord['period']>();
	const shownPeriod = $derived(settledPeriod ?? record.period);
	// The answer alone stamps the readings retained while a new period loads.
	const stamp = $derived({ kind: 'record' as const, label: recordStamp(shownPeriod, locale) });
	const pinned = $derived(finderRecordUrl(url, record.city, shownPeriod));
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

	// Readings that came drawn on the server fill the table from the first paint.
	const first = untrack(() => record);
	const firstTiming = isSettled(first.punctuality) ? first.punctuality : null;
	const reservedColumns = firstTiming
		? undefined
		: { onTime: '7.5rem', late: '5.5rem', trips: '10rem', events: '8.5rem' };
	const firstTrips = isSettled(first.trips) ? first.trips : null;
	let punctuality = $state.raw<FinderResult | null>(firstTiming);
	let delivery = $state.raw<FinderResult | null>(firstTiming ? firstTrips : null);
	let timingPending = $state(!firstTiming);
	let tripsPending = $state(!firstTrips);
	const initialTiming = $derived(timingPending && punctuality === null);
	let readingCity: string | null = null;
	let performanceCard = $state<HTMLDivElement>();
	$effect(() => {
		const { punctuality: timing, trips, city, period } = record;
		let current = true;
		let nextDelivery: FinderResult | null = null;
		// Keep the previous row set and answer height for same-city period changes.
		if (readingCity !== city) {
			punctuality = null;
			delivery = null;
			settledPeriod = undefined;
		}
		readingCity = city;
		// A settled reading is shown at once, so hydration never goes back to waiting.
		if (isSettled(trips)) {
			nextDelivery = trips;
			tripsPending = false;
		} else tripsPending = true;
		if (isSettled(timing)) {
			punctuality = timing;
			settledPeriod = period;
			delivery = nextDelivery;
			timingPending = false;
		} else {
			timingPending = true;
			void timing.then(async (answer) => {
				if (!current) return;
				const before = performanceCard?.getBoundingClientRect();
				punctuality = answer;
				settledPeriod = period;
				delivery = nextDelivery;
				timingPending = false;
				await tick();
				if (current && before && before.top < 0 && before.bottom > 120 && performanceCard) {
					const after = performanceCard.getBoundingClientRect();
					// A shorter list can lose the row that was being read. Keep its card in view.
					const top = after.height > 120 - before.top ? before.top : 120;
					const delta = after.top - top;
					if (Math.abs(delta) > 1) window.scrollBy(0, delta);
				}
			});
		}
		if (!isSettled(trips))
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
				label: name ?? number ?? label,
				// Every row carries its plate, the route ID when the timetable gives no number.
				plate: { code: number ?? row.id, scheduleOnly: row.noLive },
				detail: display.directory.subtitle(row.id),
			};
		}),
	);
	type Row = (typeof all)[number] & { hold?: LineHold | null };

	const scheduleOnly = $derived(all.filter((row) => row.noLive));
	// Rankings' floors for a line: the headline uses the lines Rankings would rank.
	const floors = $derived(
		punctuality?.kind === 'answer'
			? punctuality.answer.info?.find(({ id }) => id === 'on_time')?.ranking_floors?.line
			: undefined,
	);
	const measured = $derived(
		orderedLines(
			all
				.filter((row) => !row.noLive && row.onTime !== null)
				.map((row) => {
					const hold = lineHold(row.timing, floors);
					return {
						...row,
						hold,
						detail: belowRankingFloor(hold)
							? [row.detail, lineHoldText(hold, locale)].filter(Boolean).join(' · ')
							: row.detail,
					};
				}),
			sort,
			locale,
		),
	);
	const ranked = $derived(measured.filter(({ hold }) => hold === null));
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
	const noneScheduled = $derived(
		excludedShown.length > 0 && excludedShown.every(({ timing }) => !timing),
	);
	const matchCount = $derived(measuredShown.length + scheduleShown.length + excludedShown.length);
	const singleMatchList = $derived(
		matchCount === 1
			? measuredShown.length
				? measuredTitle
				: scheduleShown.length
					? noLiveTitle
					: excludedTitle
			: null,
	);
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
	const spread = $derived(lineSpread(ranked, locale));
	const answer = $derived(
		ranked.length === 1
			? t(
					'is the on-time share for the one line with enough to judge on these dates.',
					'est la part à l’heure de la seule ligne avec assez de données pour conclure pour ces dates.',
				)
			: t(
					`is the spread of on-time share across the ${tally(ranked.length, locale)} lines with enough to judge on these dates.`,
					`est la plage des parts à l’heure des ${tally(ranked.length, locale)} lignes qui ont assez de données pour conclure à ces dates.`,
				),
	);
	const noneRanked = $derived(
		t(
			'No line has enough to judge on these dates. Each one is in the table with its state.',
			'Aucune ligne n’a assez de données pour conclure pour ces dates. Chacune figure dans le tableau avec son état.',
		),
	);
	const timingAnswer = $derived(punctuality?.kind === 'answer' ? punctuality.answer : null);
	const timingFailure = $derived(
		!timingPending && punctuality && punctuality.kind !== 'answer' && punctuality.kind !== 'busy',
	);
	const tripsFailure = $derived(
		!timingPending && delivery && delivery.kind !== 'answer' && delivery.kind !== 'busy',
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
			href: finderCsv(headers, rows, locale, record.city, shownPeriod, sources),
			download: `${section}-${shownPeriod.from}-${shownPeriod.to}.csv`,
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
			cell: onTimeCell,
		},
		{
			key: 'late',
			header: lateHeader,
			sortable: true,
			numeric: true,
			cell: lateCell,
		},
		{
			key: 'trips',
			header: tripsHeader,
			sortable: true,
			numeric: true,
			cell: tripsCell,
		},
		{
			key: 'events',
			header: eventsHeader,
			numeric: true,
			cell: eventsCell,
		},
	]);
	const stateColumns = $derived<DataTableColumn<Row>[]>([
		{ key: 'status', header: statusHeader, cell: stateCell },
	]);
	// The page's counts are the sum of its three lists, so they match every other screen.
	const totals = $derived(
		all.reduce(
			(acc, row) => {
				const ran = row.delivery?.evidence.counts.ran;
				return {
					events: acc.events + (row.timing?.evidence.counts.classified ?? 0),
					trips: ran == null ? acc.trips : (acc.trips ?? 0) + ran,
				};
			},
			{ events: 0, trips: null as number | null },
		),
	);
	const days = $derived(timingEvidence ? countedRecordDays(timingEvidence, locale) : '');
	const counts = $derived(
		measured.length ? recordCounts(totals.events, totals.trips, days, locale) : null,
	);
	// The headline counts only the lines it spans.
	const rankedEvents = $derived(
		ranked.reduce((total, row) => total + (row.timing?.evidence.counts.classified ?? 0), 0),
	);
	const headlineSample = $derived(
		ranked.length
			? [
					t(
						`${countedUnit(rankedEvents, 'event', locale)} on ${countedUnit(ranked.length, 'line', locale)}`,
						`${countedUnit(rankedEvents, 'event', locale)} sur ${countedUnit(ranked.length, 'line', locale)}`,
					),
					days,
				]
					.filter(Boolean)
					.join(', ')
			: null,
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
	<CiteBlock
		{locale}
		text={pageCitation(
			title,
			shownPeriod,
			pinned.href,
			locale,
			operator ? citationSource(operator, provider, locale) : null,
		)}
	/>
{/snippet}

{#snippet figures()}
	{#if timingEvidence}<CiteBlock
			{locale}
			text={`Transit. ${title}. ${csvTiming}. ${citeDates(shownPeriod, locale)}. ${methodEvidence(timingEvidence, locale)}`}
		/>{/if}
	{#if deliveryEvidence}<CiteBlock
			{locale}
			text={`Transit. ${title}. ${csvTrips}. ${citeDates(shownPeriod, locale)}. ${methodEvidence(deliveryEvidence, locale)}`}
		/>{/if}
{/snippet}

{#snippet actions()}
	{#if punctuality || delivery}
		<RecordActionGroup
			{locale}
			href={pinned.href}
			{files}
			reserveDownload={!firstTiming}
			{citation}
			figures={timingEvidence || deliveryEvidence ? figures : undefined}
		/>
	{/if}
{/snippet}

{#snippet pendingCell()}<Skeleton class="ml-auto h-4 w-12 max-w-full" />{/snippet}

{#snippet onTimeCell(row: Row)}
	{#if initialTiming}{@render pendingCell()}
	{:else if belowRankingFloor(row.hold)}
		<span class="font-sans text-muted-foreground @min-[48rem]:whitespace-nowrap">{tooFew}</span>
	{:else}
		<strong class="font-sans text-base">{recordPercent(row.onTime!, locale)}</strong>
		{#if row.hold}<small class="block font-sans text-muted-foreground"
				>{lineHoldText(row.hold, locale)}</small
			>{/if}
	{/if}
{/snippet}

{#snippet phoneOnTime(row: Row)}
	{#if initialTiming}{@render pendingCell()}{:else}{belowRankingFloor(row.hold)
			? tooFew
			: recordPercent(row.onTime!, locale)}{/if}
{/snippet}

{#snippet lateCell(row: Row)}
	{#if initialTiming}{@render pendingCell()}
	{:else if belowRankingFloor(row.hold)}
		<span class="font-sans text-muted-foreground @min-[48rem]:whitespace-nowrap">{tooFew}</span>
	{:else}<RecordTableValue
			{locale}
			text={row.late === null ? null : recordPercent(row.late, locale)}
		/>{/if}
{/snippet}

{#snippet tripsCell(row: Row)}
	{@const counts = row.delivery?.evidence.counts}
	{#if row.trips !== null && counts}
		<span class="min-[1024px]:@min-[48rem]:whitespace-nowrap">
			{recordRatio(counts!.ran!, tally(counts!.scheduled!, locale), locale)}
		</span>
	{:else if tripsPending || timingPending}{@render pendingCell()}
	{:else}
		<RecordTableValue
			{locale}
			text={tripsFailure ? t('Unavailable', 'Indisponible') : null}
			state={recordStateFor(row.delivery?.state)}
		/>
	{/if}
{/snippet}

{#snippet eventsCell(row: Row)}
	{@const count = row.timing?.evidence.counts.classified}
	{#if initialTiming}{@render pendingCell()}
	{:else}<RecordTableValue {locale} text={count == null ? null : tally(count, locale)} />{/if}
{/snippet}

{#snippet stateCell(row: Row)}
	{@const reason = lineExclusion(row.timing)}
	{#if initialTiming}{@render pendingCell()}
	{:else}
		{@const state = reason.state}
		<StateMark {state} {locale} />
		{#if reason.text}
			<p class="font-sans text-muted-foreground">{reason.text[locale]}</p>
		{:else if state === 'too_few_to_judge' && row.timing?.evidence.counts.classified != null}
			<p class="font-sans text-muted-foreground">
				{countedUnit(row.timing.evidence.counts.classified, 'event', locale)}{minimum == null
					? '.'
					: t(
							`. A line needs ${tally(minimum, locale)} to show a share.`,
							`. Il en faut ${tally(minimum, locale)} pour afficher une part.`,
						)}
			</p>
		{:else if row.timing?.evidence.coverage_reason === 'insufficient_coverage'}
			<p class="font-sans text-muted-foreground">
				{t(
					'There were too few readings to cover the scheduled stops.',
					'Il y avait trop peu de relevés pour couvrir les arrêts prévus.',
				)}
			</p>
		{:else if row.timing?.state_text[locale] && row.timing.state_text[locale] !== recordState(state)[locale]}
			<p class="font-sans text-muted-foreground">{row.timing.state_text[locale]}</p>
		{/if}
	{/if}
{/snippet}

{#snippet measuredEvidence()}
	{#if timingEvidence}<RecordEvidenceLine {locale} evidence={timingEvidence} sample={counts} />{/if}
{/snippet}

{#snippet excludedEvidence()}
	{#if timingEvidence}<RecordEvidenceLine {locale} evidence={timingEvidence} />{/if}
{/snippet}

{#snippet waitingStatement()}
	<RecordPending
		{locale}
		shape="line"
		answer={initialTiming ? record.punctuality : undefined}
		busy={!initialTiming}
	/>
{/snippet}

{#snippet waitingActions()}
	<div
		class="flex h-11 w-[28rem] max-w-full gap-2"
		class:waiting-actions-fr={locale === 'fr'}
		aria-hidden="true"
	>
		{#each [0, 1, 2, 3] as action (action)}
			<Skeleton class="min-w-0 flex-1" />
		{/each}
	</div>
{/snippet}

{#snippet waitingEvidence()}
	<Skeleton class="h-4 w-64 max-w-full" />
{/snippet}

{#snippet lead()}
	{#if !punctuality || punctuality.kind === 'busy'}
		<RecordAnswer
			listing
			{locale}
			time={stamp}
			value={null}
			sentence=""
			statement={waitingStatement}
			actions={waitingActions}
			meta={waitingEvidence}
		/>
	{:else if spread !== null}
		<RecordAnswer
			listing
			{locale}
			time={stamp}
			value={spread}
			size="md"
			sentence={answer}
			evidence={timingEvidence ? { sample: headlineSample ?? '' } : undefined}
			{actions}
		/>
	{:else if measured.length}
		<RecordAnswer
			listing
			{locale}
			time={stamp}
			value={null}
			sentence={noneRanked}
			state="too_few_to_judge"
			{actions}
		/>
	{:else}
		<RecordAnswer
			listing
			{locale}
			time={stamp}
			value={null}
			sentence={timingFailure ? recordConnection.unreachable[locale] : noReading}
			state={timingFailure ? undefined : 'not_measured'}
			{actions}
		/>
	{/if}
{/snippet}

{#snippet summary()}
	{#if appliedQuery && !typing}
		<div>
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
			{#if singleMatchList}
				<p class="mt-2 text-small text-muted-foreground">
					{t(`Match in “${singleMatchList}”.`, `Résultat sous «\u00a0${singleMatchList}\u00a0».`)}
				</p>
			{/if}
			<noscript><a href={clearHref}>{t('Clear filters', 'Effacer les filtres')}</a></noscript>
		</div>
	{/if}
	{#if timingAnswer && !appliedQuery}
		<p>
			{t(
				`${countedUnit(all.length, 'line', locale)} ${all.length === 1 ? 'is' : 'are'} listed here: ${tally(measured.length, locale)} measured, ${tally(scheduleOnly.length, locale)} without live data, ${tally(excluded.length, locale)} that cannot be judged on these dates.`,
				`${countedUnit(all.length, 'line', locale)} ${all.length === 1 ? 'figure' : 'figurent'} ici\u00a0: ${tally(measured.length, locale)} avec des mesures, ${tally(scheduleOnly.length, locale)} sans données en direct, ${tally(excluded.length, locale)} qu’on ne peut pas juger à ces dates.`,
			)}
		</p>
	{/if}
{/snippet}

{#snippet sortControl()}
	{#if initialTiming}
		<div class="grid min-h-[54px] content-center"><Skeleton class="h-11 w-36" /></div>
	{:else if measuredShown.length}
		<ListingSort {locale} sort={sortChoices} />
	{/if}
{/snippet}

{#snippet lineRows()}
	{#if initialTiming}
		{#key record.punctuality}<RecordPending
				shape={{ shape: 'rows', count: 20, lines: 2, lead: 'plate' }}
				{locale}
				answer={record.punctuality}
			/>{/key}
	{:else}
		{#if timingFailure || tripsFailure}
			<p>{recordConnection.unreachable[locale]}</p>
		{/if}
		{#if measuredShown.length}
			<RecordDataTable
				{locale}
				title={measuredTitle}
				{reservedColumns}
				rowHeader={lineHeader}
				rows={measuredShown}
				columns={measuredColumns}
				value="onTime"
				sort={sortChoices}
				showSortChoices={false}
				phone={{
					includeRailTier: true,
					reserveLine: !firstTiming,
					value: phoneOnTime,
					line: (row) => {
						const counts = row.delivery?.evidence.counts;
						const events = row.timing?.evidence.counts.classified;
						return rowSentence(
							[
								row.detail,
								!belowRankingFloor(row.hold) && row.late !== null && lateShare(row.late, locale),
								row.trips !== null &&
									counts?.ran != null &&
									counts.scheduled != null &&
									tripsRan(counts.ran, counts.scheduled, locale),
								events != null && countedUnit(events, 'event', locale),
								row.hold?.reason === 'low_coverage' && lineHoldText(row.hold, locale),
							],
							locale,
						);
					},
				}}
			/>
		{:else if appliedQuery && measured.length}
			<StateNotice presentation="frameless" title={noMatch} role="status" />
		{:else if timingAnswer}
			<StateNotice
				presentation="frameless"
				title={t('No measured lines.', 'Aucune ligne mesurée.')}
				role="status"
			/>
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
	{/if}
{/snippet}

{#snippet related()}
	<div id="lines-without-live-data">
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
					rows={scheduleShown.map((row) => ({ ...row, detail: undefined }))}
				/>
			{:else if appliedQuery && scheduleOnly.length}
				<p>{noMatch}</p>
			{:else if timingAnswer || initialTiming}
				<p>{t('No lines without live data.', 'Aucune ligne sans données en direct.')}</p>
			{:else if timingFailure}
				<p>{recordConnection.unreachable[locale]}</p>
			{/if}
		</RecordCard>
	</div>

	<RecordCard
		title={excludedTitle}
		interactive={!timingFailure && !!timingAnswer && excludedShown.length > 0}
		evidence={!timingPending && timingEvidence && excluded.some(({ timing }) => timing)
			? excludedEvidence
			: undefined}
	>
		{#if initialTiming}
			<RecordPending
				{locale}
				answer={record.punctuality}
				shape={{
					shape: 'rows',
					count: Math.min(20, excludedShown.length),
					lines: 1,
					lead: 'plate',
				}}
			/>
		{:else if timingFailure}
			<p>{recordConnection.unreachable[locale]}</p>
		{:else if timingAnswer}
			{#if excludedShown.length}
				{#if noneScheduled}
					<p class="mb-2">
						{t(
							`No trip was scheduled on these dates for ${countedUnit(excludedShown.length, 'line', locale)}.`,
							`Aucun trajet n’était prévu à ces dates pour ${countedUnit(excludedShown.length, 'line', locale)}.`,
						)}
					</p>
				{/if}
				<RecordDataTable
					{locale}
					title={excludedTitle}
					rowHeader={lineHeader}
					rows={excludedShown}
					columns={noneScheduled ? [] : stateColumns}
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
{/snippet}

{#snippet methodology()}
	<AboutFigures
		title={about.about}
		compact
		fields={[
			{ key: 'period', label: about.period, text: dateRange(shownPeriod, locale) },
			{
				key: 'counted',
				label: t('Network', 'Réseau'),
				waitingLines: initialTiming ? 2 : undefined,
				text: counts ? `${counts}.` : null,
			},
			{
				key: 'observed',
				label: about.observed,
				waitingLines: initialTiming ? 5 : undefined,
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
				link: {
					href: carryFrameState(localizeHref('/metrics', locale, record.city), pinned),
					label: about.method,
				},
			},
			{
				key: 'source',
				label: about.source,
				text: operator
					? `${about.feeds(agencyName(operator, provider))} ${about.recordStart(dateRange({ from: recordStart(provider), to: recordStart(provider) }, locale))}`
					: null,
			},
			{
				key: 'error',
				label: t('Seen an error?', 'Vous avez vu une erreur?'),
				text: null,
				link: {
					href: carryFrameState(
						localizeHref('/metrics#about-transit', locale, record.city),
						pinned,
					),
					label: t('About Transit', 'À propos de Transit'),
				},
			},
		]}
	/>
{/snippet}

<ListingScreen
	{locale}
	head={{ title, subtitle }}
	answer={lead}
	introClass={[
		!firstTiming && 'line-listing-await',
		timingPending && !initialTiming && 'opacity-65',
	]
		.filter(Boolean)
		.join(' ')}
	answerBusy={timingPending || undefined}
	title={measuredTitle}
	search={all.length
		? {
				url,
				value: query,
				label: t('Line number or name', 'Numéro ou nom de ligne'),
				placeholder: t('Line number or name', 'Numéro ou nom de ligne'),
				hint: t('The lists narrow as you type.', 'Les listes se précisent pendant la saisie.'),
				testId: 'lines-filter-input',
				onInput: queueQuery,
				onSubmit: () => applyQuery(query, false),
			}
		: undefined}
	resultCountText={appliedQuery && !typing ? filterCountText(matchCount, countLabels, locale) : ''}
	{summary}
	sort={sortControl}
	children={lineRows}
	{related}
	about={methodology}
	bind:cardElement={performanceCard}
	card={{
		id: 'line-performance',
		class: 'min-[1280px]:min-h-[clamp(0px,calc(100svh_-_16rem),40rem)]',
		busy: timingPending || tripsPending,
		retained: timingPending && !initialTiming,
		interactive: initialTiming || all.length > 0,
		evidence: !timingPending && timingEvidence && measured.length ? measuredEvidence : undefined,
	}}
/>

<style>
	/* A streamed answer keeps room for its longest statement and the actions below it. */
	:global(.line-listing-await) {
		min-block-size: calc(26.25rem - var(--listing-heading-reserve));
	}

	@media (width < 24rem) {
		:global(.line-listing-await) {
			min-block-size: calc(32rem - var(--listing-heading-reserve));
		}
	}

	@media (width >= 40rem) {
		:global(.line-listing-await) {
			min-block-size: calc(17.5rem - var(--listing-heading-reserve));
		}
	}

	@media (width >= 80rem) {
		:global(.line-listing-await) {
			min-block-size: calc(10.5rem - var(--listing-heading-reserve));
		}
	}

	.waiting-actions-fr {
		inline-size: 30rem;
	}

	@container listing-screen (min-width: 64rem) {
		/* The shared wide rows stay in place while the first reading and its actions arrive. */
		:global(.listing-group:has(> .line-listing-await)) {
			grid-template-rows: auto minmax(3.5rem, auto) minmax(1.5rem, auto);
		}
	}
</style>
