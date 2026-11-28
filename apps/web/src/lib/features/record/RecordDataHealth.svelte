<script lang="ts">
	import { whenAll, type Awaitable } from '#lib/site/ready.ts';
	import type { Snippet } from 'svelte';
	import RecordScreen from '#lib/features/record/RecordScreen.svelte';
	import RecordGroup from '#lib/features/record/RecordGroup.svelte';
	import GoodToBadHourGrid from '#lib/components/dataviz/GoodToBadHourGrid.svelte';
	import { goodToBadStep } from '#lib/components/dataviz/goodToBadScale.ts';
	import type { HourGridCell } from '@yesid/ui/chart';
	import { DashboardGrid } from '@yesid/ui/layout';
	import { intl, localizeHref, type Locale } from '#lib/i18n/index.ts';
	import type {
		DataHealthAnswer,
		EngineResult,
		MeasureAnswer,
		MethodEntry,
		RecordMeasure,
		RecordSeries,
		ScorecardAnswer,
	} from '#lib/server/engine.ts';
	import type { AgencyScorecardMeasure } from '#lib/server/screenQuestions.ts';
	import { networkMeasures } from '#lib/features/network/networkMeasures.ts';
	import { page } from '$app/state';
	import { carryFrameState, frameHref, recordStart } from '#lib/site/frameState.ts';
	import {
		countedUnit,
		citeDates,
		dateRange,
		frenchAgency,
		gridDaysNote,
		longDate,
		methodEvidence,
		officialAlertsLabel,
		recordDate,
		recordStamp,
		sampleWithMinimum,
		singularCount,
	} from '#lib/site/presenter.ts';
	import type { DateWindow } from '#lib/v1/history/window.ts';
	import {
		collectionGaps,
		feedCheckRows,
		feedCheckSample,
		minimumNote,
		minimumSample,
		predictionReadings,
		predictionsNotMeasured,
		publishingRows,
		publishingSample,
		publishStateText,
		scorecardDays,
		scorecardState,
		stopEventCoverage,
		tripCoverageFacts,
		tripsLeftOutByDay,
		vehicleReportRows,
		type HealthRow,
	} from '../health/agencyHealthText.ts';
	import { healthReading, tableName } from './dataHealthText.ts';
	import FactList from './FactList.svelte';
	import FactRow from './FactRow.svelte';
	import RecordActionGroup from './RecordActionGroup.svelte';
	import CiteBlock from './CiteBlock.svelte';
	import RecordAnswer from './RecordAnswer.svelte';
	import AboutFigures from './AboutFigures.svelte';
	import RecordCard from './RecordCard.svelte';
	import RecordDataTable, { type RecordTableRow } from './RecordDataTable.svelte';
	import RecordEvidenceLine from './RecordEvidenceLine.svelte';
	import PhoneSwitch from './PhoneSwitch.svelte';
	import RecordPending from './RecordPending.svelte';
	import ScreenTitle from './ScreenTitle.svelte';
	import StateMark from './StateMark.svelte';
	import { recordSectionLinks } from './recordLinks.ts';
	import { choose, lastGoodNote, recordConnection, tally } from './recordText.ts';
	import { overviewCopy } from '../home/overviewRecord.copy.ts';

	type Result<T> = Awaitable<EngineResult<T>>;

	let {
		locale,
		url,
		record,
		alerts = { tracked: true },
		operatorOf = null,
		subject = '',
		operator = '',
	}: {
		locale: Locale;
		url: URL;
		record: {
			city: string;
			period: DateWindow;
			coverage: Result<MeasureAnswer>;
			accessibility: Result<RecordMeasure>;
			alertEffects: Result<RecordSeries> | null;
			alertCount?: Result<RecordMeasure> | null;
			deliveryDays: Result<RecordSeries>;
			scorecard: Record<AgencyScorecardMeasure, Result<ScorecardAnswer>>;
			health: Result<DataHealthAnswer>;
			methods: Result<MethodEntry[]>;
		} | null;
		alerts?: { tracked: boolean; officialUrl?: string };
		/** The French form of the agency after "de", as the city declares it. */
		operatorOf?: string | null;
		subject?: string;
		operator?: string;
	} = $props();

	const t = (en: string, fr: string) => choose(locale, en, fr);
	// Each city's record starts on its own declared first day.
	const start = $derived(recordStart(page.data.provider));
	const term = $derived(overviewCopy[locale]);
	const title = $derived(t('Data health', 'Santé des données'));
	const agencyLabel = $derived(operator || subject);
	const agency = $derived({ name: agencyLabel, frenchOf: operatorOf });
	const french = $derived(frenchAgency(agency));
	const titles = $derived({
		publishes: t(`What ${agencyLabel} publishes`, `Ce que publie ${french.subject}`),
		coverage: t('Live trip coverage', 'Couverture des trajets en direct'),
		reports: t('Details in vehicle reports', 'Détails transmis par les véhicules'),
		predictions: t('Arrival predictions', 'Prévisions d’arrivée'),
		feeds: t('Feed checks and outages', 'Vérifications des flux et interruptions'),
		days: t('Days in the record', 'Jours dans le bilan'),
		changes: t('Method changes', 'Mises à jour des méthodes'),
	});
	const stamp = $derived(
		record ? { kind: 'record' as const, label: recordStamp(record.period, locale) } : undefined,
	);
	const pinned = $derived.by(() => {
		const selected = new URL(url.pathname, url);
		if (record) selected.searchParams.set('provider', record.city);
		return new URL(
			frameHref(selected, { mode: 'record', period: record && { ...record.period, preset: null } }),
			url,
		);
	});
	const share = $derived(recordSectionLinks(pinned, 'stop-events').share);
	// The network record serves each scorecard measure's CSV for the same dates.
	const files = $derived.by(() => {
		const network = new URL(
			pinned.pathname.replace(/\/status\/?$/, '/network') + pinned.search,
			pinned,
		);
		const measures: AgencyScorecardMeasure[] = [
			'live_trip_coverage',
			'vehicle_field_completeness',
			'prediction_error',
			'poll_success',
			'feed_age_at_capture',
		];
		return measures.map((measure) => ({
			label: choose(locale, ...networkMeasures[measure].title),
			href: recordSectionLinks(network, measure).csv,
		}));
	});
	const methodHref = $derived(
		carryFrameState(localizeHref('/metrics', locale, record?.city), pinned),
	);

	const labels = $derived({
		present: t('Present', 'Présent'),
		missing: t(
			'Missing: not in the record for that day',
			'Manquant\u00a0: absent du bilan pour ce jour',
		),
		not_measured: t('Not measured: its source was missing', 'Non mesuré\u00a0: la source manquait'),
		incomplete: t('Incomplete', 'Incomplet'),
		not_tracked: t('Transit did not track this', 'Transit n’a pas suivi cette donnée'),
		not_published: t('Not published', 'Non publié'),
		unknown: t('Unknown', 'Inconnu'),
	});
	const legendLabels = $derived({
		...labels,
		not_published: t(
			`Not published: ${agencyLabel} does not publish it`,
			`Non publié\u00a0: ${french.subject} ne le publie pas`,
		),
	});
	const marks = {
		present: { text: '●', level: 0 },
		not_tracked: { text: '⊠', level: null, state: 'unmeasured' },
		not_published: { text: '□', level: null, state: 'unmeasured' },
		unknown: { text: '?', level: null, state: 'unmeasured' },
		incomplete: { text: '◐', level: 2 },
		missing: { text: '×', level: 4 },
		not_measured: { text: '○', level: null, state: 'unmeasured' },
	} as const satisfies Record<string, Omit<HourGridCell, 'name'>>;
	const familiesFor = (entries: MethodEntry[]) => [
		...new Map(
			entries
				.toSorted((left, right) => left.since.localeCompare(right.since))
				.map((entry) => [entry.family, entry]),
		).values(),
	];
	const tablesFor = (answer: DataHealthAnswer) => [
		...new Set(answer.days.flatMap((day) => Object.keys(day.tables))),
	];

	function daysSummary(answer: DataHealthAnswer) {
		const days = answer.days.length;
		const gaps = answer.days.filter(({ tables }) =>
			Object.values(tables).some(({ status }) => status !== 'present' && status !== 'not_tracked'),
		).length;
		// A feed the agency never publishes is not a file Transit keeps, so it is named apart.
		const unpublished = !alerts.tracked && tablesFor(answer).includes('alerts');
		if (!gaps)
			return unpublished
				? t(
						`The files Transit keeps are present for every day in this period. ${agencyLabel} does not publish service alerts.`,
						`Les fichiers que Transit conserve sont présents pour chaque jour de cette période. ${french.subject} ne publie pas d’avis de service.`,
					)
				: t(
						'The files tracked here are present for every day in this period.',
						'Les fichiers suivis ici sont présents pour chaque jour de cette période.',
					);
		return t(
			`${tally(gaps, locale)} of ${countedUnit(days, 'day', locale)} ${gaps === 1 ? 'has' : 'have'} a gap.`,
			`${tally(gaps, locale)} ${singularCount(gaps, locale) ? 'jour' : 'jours'} sur ${tally(days, locale)} ${singularCount(gaps, locale) ? 'a une lacune' : 'ont une lacune'}.`,
		);
	}

	function daysSample(answer: DataHealthAnswer) {
		const kinds = tablesFor(answer).length;
		return t(
			`${tally(kinds, locale)} ${kinds === 1 ? 'kind' : 'kinds'} of data, ${countedUnit(answer.days.length, 'day', locale)}`,
			`${tally(kinds, locale)} ${singularCount(kinds, locale) ? 'type' : 'types'} de données, ${countedUnit(answer.days.length, 'day', locale)}`,
		);
	}

	function grid(answer: DataHealthAnswer, count: number) {
		const days = answer.days.slice(-count);
		const tables = tablesFor(answer);
		const cellState = (date: (typeof days)[number], id: string) => {
			const status = date.tables[id]?.status ?? 'unknown';
			return id === 'alerts' && status === 'not_tracked' && !alerts.tracked
				? 'not_published'
				: status;
		};
		const states = new Set<keyof typeof marks>([
			'present',
			'missing',
			'not_measured',
			...days.flatMap((day) => tables.map((id) => cellState(day, id))),
		]);
		const day = intl.dateTime(locale, { day: 'numeric', timeZone: 'UTC' });
		return {
			columns: days.map(({ service_date }) => ({
				id: service_date,
				label: day.format(new Date(service_date)),
			})),
			rows: tables.map((id) => ({
				id,
				label: tableName(id, locale),
				cells: days.map((date): HourGridCell => {
					const cell = date.tables[id];
					const state = cellState(date, id);
					return {
						...marks[state],
						name:
							state === 'not_published'
								? labels.not_published
								: healthReading(cell, locale, cell?.status === 'present' ? undefined : date.reason),
					};
				}),
			})),
			from: days[0]?.service_date,
			to: days.at(-1)?.service_date,
			states: (
				[
					'present',
					'incomplete',
					'missing',
					'not_measured',
					'not_tracked',
					'not_published',
					'unknown',
				] as const
			).filter((state) => states.has(state)),
		};
	}

	function tooFewNote(answer: ScorecardAnswer, measure: string, sample: string) {
		const minimum = minimumSample(answer, measure);
		return minimum == null ? sample : sampleWithMinimum(sample, minimum, locale);
	}
	// One row per thing riders rely on: the notices row only where the agency publishes notices.
	const publishingShape = $derived({
		shape: 'rows',
		count: alerts.tracked ? 5 : 4,
		lines: 2,
		lead: 'none',
	} as const);
	const daysShape = { shape: 'table', rows: 7 } as const;
</script>

{#snippet unavailable(result: { kind: string })}
	{#if result.kind === 'busy'}<RecordPending {locale} busy />
	{:else}<p>{recordConnection.unreachable[locale]}</p>{/if}
{/snippet}

{#snippet stateCell(row: RecordTableRow & HealthRow)}
	{#if row.state === 'published'}<span class="font-sans font-semibold"
			>{publishStateText(row.state, locale)}</span
		>
	{:else if row.state === 'unavailable'}<span class="font-sans"
			>{publishStateText(row.state, locale)}</span
		>
	{:else}<StateMark state={row.state} {locale} />{/if}
{/snippet}
{#snippet shareCell(row: RecordTableRow & { share: string })}<span class="reading">{row.share}</span
	>{/snippet}
{#snippet rightCell(row: RecordTableRow & { right: string })}<span class="reading">{row.right}</span
	>{/snippet}
<!-- A feed the agency does not publish reads as its state, not as a figure. -->
{#snippet answeredCell(
	row: RecordTableRow & { answered: string },
)}{#if !alerts.tracked && row.answered === labels.not_published}<StateMark
			state="not_published"
			{locale}
		/>{:else}{row.answered}{/if}{/snippet}
{#snippet checkedCell(row: RecordTableRow & { checked: string })}{row.checked}{/snippet}

<!-- One card for each scorecard answer: the waiting, failing and one-state cases are shared. -->
{#snippet scorecardCard(
	id: AgencyScorecardMeasure,
	shape: import('./recordWaiting.ts').RecordWaiting,
	cardTitle: string,
	result: Result<ScorecardAnswer>,
	body: Snippet<[ScorecardAnswer]>,
	sample: (answer: ScorecardAnswer) => string | null,
	notMeasured?: (answer: ScorecardAnswer) => string | null,
)}
	<!-- While it waits the card keeps its reading's shape; a one-state answer keeps no empty space. -->
	{#snippet card(settled?: Awaited<Result<ScorecardAnswer>>)}
		{@const answer = settled?.kind === 'answer' ? settled.answer : null}
		{@const reason = answer ? (notMeasured?.(answer) ?? null) : null}
		{@const only = answer ? scorecardState(answer, id) : null}
		<RecordCard
			title={cardTitle}
			{stamp}
			stampRule
			reserve={!settled || settled.kind === 'busy' || (answer && !reason && !only)
				? shape
				: undefined}
		>
			{#if !settled}
				{#key result}<RecordPending {locale} answer={result} {shape} />{/key}
			{:else if answer}
				{#if reason}
					<!-- The whole card is one state: the state and its reason, once. -->
					<p><StateMark state="not_measured" {locale} /></p>
					<p class="mt-2 text-small text-muted-foreground">{reason}</p>
				{:else if only}
					<p><StateMark state={only} {locale} /></p>
					{#if only === 'too_few_to_judge'}
						<p class="mt-2 text-small text-muted-foreground">
							{tooFewNote(answer, id, sample(answer) ?? scorecardDays(answer, locale))}
						</p>
					{/if}
				{:else}
					{@render body(answer)}
					{@const note = minimumNote(answer, id, locale)}
					{#if note}<p class="mt-2 text-small text-muted-foreground">{note}</p>{/if}
				{/if}
				{#if settled.kind === 'answer' && settled.lastGood}<p class="mt-2">
						{lastGoodNote[locale]}
					</p>{/if}
			{:else}{@render unavailable(settled)}{/if}
			{#snippet evidence()}
				{#if answer}
					<RecordEvidenceLine
						{locale}
						evidence={answer.evidence}
						sample={notMeasured?.(answer) ? scorecardDays(answer, locale) : sample(answer)}
					/>
				{/if}
			{/snippet}
		</RecordCard>
	{/snippet}
	<section {id} class="min-w-0">
		{#await result}{@render card()}{:then settled}{@render card(settled)}{/await}
	</section>
{/snippet}

{#snippet coverageBody(answer: ScorecardAnswer)}
	{@const coverage = tripCoverageFacts(answer, locale)}
	<FactList>
		{#each coverage.facts as fact (fact.id)}
			<FactRow label={fact.label} labelDetail={fact.detail ?? undefined}>
				{#if fact.value}<span class="font-semibold">{fact.value}</span>
				{:else}<StateMark state="unknown" {locale} />{/if}
			</FactRow>
		{/each}
	</FactList>
	{#if coverage.gapNote}<p>{coverage.gapNote}</p>{/if}
{/snippet}

{#snippet reportsBody(answer: ScorecardAnswer)}
	<p class="mb-3">
		{t(
			'Share of vehicle reporting time with each detail.',
			'Part du temps de signalement où chaque détail était fourni.',
		)}
	</p>
	<RecordDataTable
		{locale}
		title={titles.reports}
		rowHeader={t('Detail', 'Détail')}
		rows={vehicleReportRows(answer, locale).rows}
		columns={[
			{
				key: 'share',
				header: t('Share of the time', 'Part du temps'),
				numeric: true,
				cell: shareCell,
			},
		]}
		value="share"
	/>
{/snippet}

{#snippet predictionsBody(answer: ScorecardAnswer)}
	{@const readings = predictionReadings(answer, locale)}
	{#if readings.sentence}<p class="mb-3 text-subheading font-semibold">{readings.sentence}</p>{/if}
	<RecordDataTable
		{locale}
		title={titles.predictions}
		rowHeader={t('Made', 'Faite')}
		rows={readings.rows}
		columns={[
			{
				key: 'right',
				header: t('Right within a minute', 'Juste à une minute près'),
				numeric: true,
				cell: rightCell,
			},
			{
				key: 'checked',
				header: t('Arrivals checked', 'Arrivées vérifiées'),
				numeric: true,
				cell: checkedCell,
			},
		]}
		value="right"
	/>
{/snippet}

{#snippet feedTable(answer: ScorecardAnswer, age?: ScorecardAnswer)}
	<RecordDataTable
		{locale}
		title={titles.feeds}
		rowHeader={t('Feed', 'Flux')}
		rows={feedCheckRows(answer, locale, age, alerts.tracked)}
		columns={[
			{
				key: 'answered',
				header: t('Answered', 'Réussies'),
				numeric: true,
				cell: answeredCell,
			},
		]}
		value="answered"
	/>
{/snippet}

{#snippet feedsBody(answer: ScorecardAnswer)}
	{@const gaps = collectionGaps(answer, locale)}
	{#await record?.scorecard.feed_age_at_capture}
		{@render feedTable(answer)}
	{:then result}
		{@render feedTable(answer, result?.kind === 'answer' ? result.answer : undefined)}
	{/await}
	{#if gaps}<p class="mt-3">{gaps}</p>{/if}
	{#if record}
		{#await record.deliveryDays then result}
			{#if result.kind === 'answer'}
				{@const notes = tripsLeftOutByDay(result.answer, locale)}
				{#if notes.length}<p class="mt-3">{notes.join(' ')}</p>{/if}
			{/if}
		{/await}
	{/if}
{/snippet}

<RecordScreen class="min-w-0">
	<div data-slot="screen-content">
		<RecordGroup>
			<ScreenTitle {title} subtitle={subject} />
			<div id="stop-events" data-slot="screen-answer">
				{#if record}
					{#await record.coverage}
						{#key record.coverage}<RecordPending
								shape="answer"
								{locale}
								answer={record.coverage}
							/>{/key}
					{:then result}
						{#if result.kind === 'busy'}<RecordPending {locale} busy />
						{:else if result.kind !== 'answer'}
							<RecordAnswer
								{locale}
								value={null}
								sentence={recordConnection.unreachable[locale]}
								time={stamp}
							/>
						{:else}
							{@const answer = result.answer}
							{@const coverage = stopEventCoverage(answer, locale)}
							<RecordAnswer
								{locale}
								value={coverage?.value ?? null}
								state={coverage ? undefined : 'not_measured'}
								sentence={coverage?.sentence ?? t('Not measured', 'Non mesuré')}
								time={stamp}
								evidence={coverage
									? { sample: coverage.counted, lastGood: result.lastGood }
									: undefined}
							>
								{#snippet meta()}
									{#if coverage}<p>{coverage.rest}</p>{/if}
								{/snippet}
								{#snippet actions()}
									<RecordActionGroup {locale} href={share} {files}>
										{#snippet citation()}
											<CiteBlock
												{locale}
												text={[
													`Transit. ${title} (${subject || record.city}). ${citeDates(record.period, locale)}.`,
													coverage ? `${coverage.value} ${coverage.sentence}` : '',
													methodEvidence(answer.evidence, locale),
													share,
												]
													.filter(Boolean)
													.join(' ')}
											/>
										{/snippet}
									</RecordActionGroup>
								{/snippet}
							</RecordAnswer>
						{/if}
					{/await}
				{:else}
					<RecordAnswer
						{locale}
						value={null}
						state="not_measured"
						sentence={t('Not measured', 'Non mesuré')}
					/>
				{/if}
			</div>

			{#if record}
				{@const publishing = whenAll(
					[
						record.accessibility,
						record.alertEffects ?? null,
						record.alertCount ?? null,
						record.scorecard.vehicle_field_completeness,
					],
					(readings) => readings,
				)}
				<section id="publishes" class="min-w-0">
					<RecordCard
						interactive={!alerts.tracked && !!alerts.officialUrl}
						title={titles.publishes}
						{stamp}
						stampRule
						reserve={publishingShape}
					>
						{#await publishing}
							<RecordPending {locale} shape={publishingShape} />
						{:then [accessibility, alertEffects, alertCount, completeness]}
							{@const rows = publishingRows(
								{ accessibility, alertEffects, alertCount, completeness },
								agency,
								locale,
								alerts,
							)}
							{#if rows.every(({ state }) => state === 'unavailable')}
								<p>{recordConnection.unreachable[locale]}</p>
							{:else}
								{#if rows.some(({ state }) => state === 'unavailable')}
									<p class="mb-3">{recordConnection.unreachable[locale]}</p>
								{/if}
								<RecordDataTable
									{locale}
									title={titles.publishes}
									rowHeader={t('What riders rely on', 'Ce dont les usagers ont besoin')}
									rows={rows.map((row) => ({ ...row, detail: row.note ?? undefined }))}
									columns={[{ key: 'state', header: t('State', 'État'), cell: stateCell }]}
									value="state"
								/>
							{/if}
						{/await}
						{#snippet links()}
							{#if !alerts.tracked && alerts.officialUrl}
								<a
									class="inline-flex min-h-11 items-center text-primary underline"
									href={alerts.officialUrl}>{officialAlertsLabel(locale)}</a
								>
							{/if}
						{/snippet}
						{#snippet evidence()}
							{#await record.accessibility then accessibility}
								{@const sample = publishingSample(accessibility, locale)}
								{#if sample}<RecordEvidenceLine {locale} {sample} versions="" />{/if}
							{/await}
						{/snippet}
					</RecordCard>
				</section>

				<DashboardGrid gutter={false} minTile="24rem" class="items-start">
					{@render scorecardCard(
						'live_trip_coverage',
						{ shape: 'facts', count: 2 },
						titles.coverage,
						record.scorecard.live_trip_coverage,
						coverageBody,
						(answer) => tripCoverageFacts(answer, locale).sample,
					)}
					{@render scorecardCard(
						'vehicle_field_completeness',
						{ shape: 'table', rows: 6 },
						titles.reports,
						record.scorecard.vehicle_field_completeness,
						reportsBody,
						(answer) => vehicleReportRows(answer, locale).sample,
					)}
				</DashboardGrid>
				<DashboardGrid gutter={false} minTile="24rem">
					{@render scorecardCard(
						'prediction_error',
						{ shape: 'table', rows: 3 },
						titles.predictions,
						record.scorecard.prediction_error,
						predictionsBody,
						(answer) => predictionReadings(answer, locale).sample,
						(answer) => predictionsNotMeasured(answer, agency, locale),
					)}
					{@render scorecardCard(
						'poll_success',
						{ shape: 'table', rows: 4 },
						titles.feeds,
						record.scorecard.poll_success,
						feedsBody,
						(answer) => feedCheckSample(answer, locale),
					)}
				</DashboardGrid>
			{/if}

			{#if record}
				<section id="days-in-record" class="min-w-0">
					<RecordCard interactive title={titles.days} {stamp} stampRule reserve={daysShape}>
						{#await record.health}
							<RecordPending {locale} shape={daysShape} answer={record.health} />
						{:then result}
							{#if result.kind === 'answer'}
								{@const display = grid(result.answer, 14)}
								{#snippet dayGrid(count: number)}
									{@const shown = grid(result.answer, count)}
									<div class="good-to-bad-grid">
										<GoodToBadHourGrid
											label={titles.days}
											scrollCue={t(
												'Scroll sideways to see all days.',
												'Faites défiler de côté pour voir tous les jours.',
											)}
											columns={shown.columns}
											rows={shown.rows}
											scale={{ label: '', steps: [] }}
											stateLabels={{ few: '', none: '', unmeasured: '' }}
											readings={shown.rows.flatMap((row) =>
												shown.columns.map(({ id }, index) => ({
													key: row.id + '/' + id,
													heading: recordDate(id, locale),
													rows: [{ label: row.label, value: row.cells[index].name }],
												})),
											)}
										/>
										<ul
											class="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-small text-muted-foreground"
											role="list"
											aria-label={t('Day states', 'États des jours')}
										>
											{#each shown.states as state (state)}
												{@const level = marks[state].level}
												{@const swatch = level === null ? undefined : goodToBadStep(level)}
												<li class="flex items-start gap-2">
													<span
														aria-hidden="true"
														class="min-w-4 shrink-0 rounded-sm text-center"
														class:border={swatch !== undefined}
														style:border-color={swatch
															? 'var(--transit-good-to-bad-grid-edge)'
															: undefined}
														style:background-color={swatch?.fill}
														style:color={swatch?.ink}>{marks[state].text}</span
													>
													{legendLabels[state]}
												</li>
											{/each}
										</ul>
									</div>
									{#if result.answer.days.length > shown.columns.length}
										<p class="mt-3 text-small text-muted-foreground">
											{gridDaysNote(shown.columns.length, locale)}
										</p>
									{/if}
								{/snippet}
								{#snippet wideGrid()}{@render dayGrid(14)}{/snippet}
								{#snippet narrowGrid()}{@render dayGrid(7)}{/snippet}
								{#if display.from && display.to && display.rows.length}
									<p class="mb-3">{daysSummary(result.answer)}</p>
									<!-- A phone shows the last 7 days, so the most recent day is always in view. -->
									<PhoneSwitch wide={wideGrid} narrow={narrowGrid} />
								{:else}<StateMark state="not_measured" {locale} />{/if}
								{#if result.lastGood}<p class="mt-2">{lastGoodNote[locale]}</p>{/if}
							{:else}{@render unavailable(result)}{/if}
						{/await}
						{#snippet links()}
							<a class="inline-flex min-h-11 items-center text-primary underline" href={methodHref}
								>{term.method}</a
							>
						{/snippet}
						{#snippet evidence()}
							{#await record.health then result}
								{#if result.kind === 'answer'}
									<RecordEvidenceLine {locale} sample={daysSample(result.answer)} versions="" />
								{/if}
							{/await}
						{/snippet}
					</RecordCard>
				</section>
				<RecordCard title={titles.changes}>
					{#await record.methods}
						{#key record.methods}<RecordPending {locale} answer={record.methods} />{/key}
					{:then result}
						{#if result.kind !== 'answer'}{@render unavailable(result)}
						{:else if result.answer.length}
							{@const families = familiesFor(result.answer)}
							{@const dates = new Set(families.map(({ since }) => since))}
							{@const common = [...dates].find(
								(date) =>
									families.filter(({ since }) => since === date).length * 2 > families.length,
							)}
							{#if result.lastGood}<p>{lastGoodNote[locale]}</p>{/if}
							{#if dates.size === 1}
								<p>
									{t(
										`Every measure last changed on ${longDate(families[0].since, locale)}.`,
										`Toutes les mesures ont changé pour la dernière fois le ${longDate(families[0].since, locale)}.`,
									)}
									{t(
										`The record starts ${longDate(start, locale)} and is rebuilt each night, after the service day closes.`,
										`Le bilan commence le ${longDate(start, locale)} et est recalculé chaque nuit, après la fin de la journée de service.`,
									)}
								</p>
							{:else}
								{#if common}<p class="mb-3">
										{t(
											`Most measure families last changed on ${longDate(common, locale)}.`,
											`La plupart des familles de mesures ont changé pour la dernière fois le ${longDate(common, locale)}.`,
										)}
									</p>{/if}
								<p class="mb-3">
									{t(
										`The record starts ${longDate(start, locale)} and is rebuilt each night, after the service day closes.`,
										`Le bilan commence le ${longDate(start, locale)} et est recalculé chaque nuit, après la fin de la journée de service.`,
									)}
								</p>
								{#snippet since(row: RecordTableRow & { since: string })}
									<time datetime={row.since}>{longDate(row.since, locale)}</time>
								{/snippet}
								<RecordDataTable
									{locale}
									title={titles.changes}
									rowHeader={t('Measure family', 'Famille de mesures')}
									rows={families
										.filter(({ since }) => since !== common)
										.map((entry) => ({
											id: entry.family,
											label: entry.family_text?.[locale] ?? entry.family,
											href: `${methodHref}#${entry.id}`,
											since: entry.since,
										}))}
									columns={[
										{ key: 'since', header: t('Last changed', 'Dernier changement'), cell: since },
									]}
									value="since"
									phone={{}}
								/>
							{/if}
						{:else}<StateMark state="not_measured" {locale} />{/if}
					{/await}
				</RecordCard>
			{/if}
		</RecordGroup>
		{#if record && stamp}
			<RecordGroup>
				<AboutFigures
					title={term.about}
					compact
					fields={[
						{ key: 'period', label: term.period, text: dateRange(record.period, locale) },
						{
							key: 'counted',
							label: term.counted,
							text: t(
								`Every stop arrival in ${agencyLabel}’s timetable for these dates, and its live feeds.`,
								`Chaque passage prévu à l’horaire ${french.of} à ces dates, et ses flux en direct.`,
							),
						},
						{
							key: 'method',
							label: term.methodRow,
							text: null,
							links: [
								{ href: methodHref, label: term.method },
								{
									href: methodHref + '#about-transit',
									label: t('Seen an error?', 'Vous avez vu une erreur\u00a0?'),
								},
							],
						},
						{
							key: 'source',
							label: term.source,
							text: operator ? term.feeds(agency) : null,
						},
					]}
				/>
			</RecordGroup>
		{/if}
	</div>
</RecordScreen>

<style>
	.reading {
		font-family: var(--font-body);
	}
</style>
