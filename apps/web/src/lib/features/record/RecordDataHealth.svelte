<script lang="ts">
	import type { Snippet } from 'svelte';
	import RecordScreen from '#lib/features/record/RecordScreen.svelte';
	import RecordGroup from '#lib/features/record/RecordGroup.svelte';
	import { HourGrid, type HourGridCell } from '@yesid/ui/chart';
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
	import { page } from '$app/state';
	import { carryFrameState, frameHref, recordStart } from '#lib/site/frameState.ts';
	import {
		countedUnit,
		dateRange,
		frenchAgency,
		longDate,
		methodEvidence,
		officialAlertsLabel,
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
		publishingRows,
		publishingSample,
		publishStateText,
		scorecardDays,
		scorecardState,
		stopEventCoverage,
		tripCoverageFacts,
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
	import RecordPending from './RecordPending.svelte';
	import RecordSkeleton from './RecordSkeleton.svelte';
	import ScreenTitle from './ScreenTitle.svelte';
	import StateMark from './StateMark.svelte';
	import { recordSectionLinks } from './recordLinks.ts';
	import { choose, lastGoodNote, recordConnection, tally } from './recordText.ts';
	import { overviewCopy } from '../home/overviewRecord.copy.ts';

	type Result<T> = Promise<EngineResult<T>>;

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
	const methodHref = $derived(
		carryFrameState(localizeHref('/metrics', locale, record?.city), pinned),
	);

	const labels = $derived({
		present: t('Present', 'Présent'),
		missing: t(
			'Missing: not in the record for that day',
			'Manquant\u00a0: absent du bilan pour ce jour',
		),
		not_measured: t('Not measured: its source was missing', 'Non mesuré : la source manquait'),
		incomplete: t('Incomplete', 'Incomplet'),
		not_tracked: t('Not tracked', 'Non suivi'),
		unknown: t('Unknown', 'Inconnu'),
	});
	const marks = {
		present: { text: '●', level: 0 },
		not_tracked: { text: '⊠', level: 1 },
		unknown: { text: '?', level: 2 },
		incomplete: { text: '◐', level: null, state: 'few' },
		missing: { text: '×', level: null, state: 'none' },
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
		if (!gaps)
			return t(
				'Every day of these dates is in the record.',
				'Chaque jour de cette période est dans le bilan.',
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

	function grid(answer: DataHealthAnswer) {
		const days = answer.days.slice(-14);
		const tables = tablesFor(answer);
		const states = new Set<keyof typeof marks>([
			'present',
			'missing',
			'not_measured',
			...days.flatMap((day) => tables.map((id) => day.tables[id]?.status ?? 'unknown')),
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
					const state = cell?.status ?? 'unknown';
					return {
						...marks[state],
						name: healthReading(cell, locale, cell?.status === 'present' ? undefined : date.reason),
					};
				}),
			})),
			from: days[0]?.service_date,
			to: days.at(-1)?.service_date,
			states,
		};
	}

	function tooFewNote(answer: ScorecardAnswer, measure: string, sample: string) {
		const minimum = minimumSample(answer, measure);
		return minimum == null ? sample : sampleWithMinimum(sample, minimum, locale);
	}
</script>

{#snippet unavailable(result: { kind: string })}
	{#if result.kind === 'busy'}<RecordPending {locale} busy />
	{:else}<p>{recordConnection.unreachable[locale]}</p>{/if}
{/snippet}

{#snippet stateCell(row: RecordTableRow & HealthRow)}
	{#if row.state === 'published'}<span class="font-semibold"
			>{publishStateText(row.state, locale)}</span
		>
	{:else if row.state === 'unavailable'}{publishStateText(row.state, locale)}
	{:else}<StateMark state={row.state} {locale} />{/if}
{/snippet}
{#snippet shareCell(row: RecordTableRow & { share: string })}{row.share}{/snippet}
{#snippet rightCell(row: RecordTableRow & { right: string })}{row.right}{/snippet}
{#snippet answeredCell(row: RecordTableRow & { answered: string })}{row.answered}{/snippet}
{#snippet checkedCell(row: RecordTableRow & { checked: string })}{row.checked}{/snippet}

<!-- One card for each scorecard answer: the waiting, failing and one-state cases are shared. -->
{#snippet scorecardCard(
	id: AgencyScorecardMeasure,
	cardTitle: string,
	result: Result<ScorecardAnswer>,
	body: Snippet<[ScorecardAnswer]>,
	sample: (answer: ScorecardAnswer) => string | null,
)}
	<section {id} class="min-w-0">
		<RecordCard title={cardTitle} {stamp}>
			{#await result}
				{#key result}<RecordPending {locale} answer={result} shape="table" />{/key}
			{:then settled}
				{#if settled.kind === 'answer'}
					{@const answer = settled.answer}
					{@const only = scorecardState(answer, id)}
					{#if only}
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
					{#if settled.lastGood}<p class="mt-2">{lastGoodNote[locale]}</p>{/if}
				{:else}{@render unavailable(settled)}{/if}
			{/await}
			{#snippet evidence()}
				{#await result then settled}
					{#if settled.kind === 'answer'}
						<RecordEvidenceLine
							{locale}
							evidence={settled.answer.evidence}
							sample={sample(settled.answer)}
						/>
					{/if}
				{/await}
			{/snippet}
		</RecordCard>
	</section>
{/snippet}

{#snippet coverageBody(answer: ScorecardAnswer)}
	<FactList>
		{#each tripCoverageFacts(answer, locale).facts as fact (fact.id)}
			<FactRow label={fact.label} labelDetail={fact.detail ?? undefined}>
				{#if fact.value}<span class="font-semibold">{fact.value}</span>
				{:else}<StateMark state="unknown" {locale} />{/if}
			</FactRow>
		{/each}
	</FactList>
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

{#snippet feedsBody(answer: ScorecardAnswer)}
	{@const gaps = collectionGaps(answer, locale)}
	<RecordDataTable
		{locale}
		title={titles.feeds}
		rowHeader={t('Feed', 'Flux')}
		rows={feedCheckRows(answer, locale)}
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
	<p class="mt-3">{gaps}</p>
{/snippet}

<RecordScreen class="min-w-0">
	<RecordGroup><ScreenTitle {title} subtitle={subject} /></RecordGroup>
	<div data-slot="screen-content">
		<RecordGroup>
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
									<RecordActionGroup {locale} href={share} files={[]}>
										{#snippet citation()}
											<CiteBlock
												{locale}
												text={[
													`Transit. ${title} (${subject || record.city}). ${dateRange(record.period, locale)}.`,
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
				{@const publishing = Promise.all([
					record.accessibility,
					record.alertEffects ?? Promise.resolve(null),
					record.scorecard.vehicle_field_completeness,
				])}
				<section id="publishes" class="min-w-0">
					<RecordCard
						interactive={!alerts.tracked && !!alerts.officialUrl}
						title={titles.publishes}
						{stamp}
					>
						{#await publishing}
							<RecordSkeleton shape="table" />
						{:then [accessibility, alertEffects, completeness]}
							{@const rows = publishingRows(
								{ accessibility, alertEffects, completeness },
								agency,
								locale,
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

				<DashboardGrid gutter={false} minTile="24rem">
					{@render scorecardCard(
						'live_trip_coverage',
						titles.coverage,
						record.scorecard.live_trip_coverage,
						coverageBody,
						(answer) => tripCoverageFacts(answer, locale).sample,
					)}
					{@render scorecardCard(
						'vehicle_field_completeness',
						titles.reports,
						record.scorecard.vehicle_field_completeness,
						reportsBody,
						(answer) => vehicleReportRows(answer, locale).sample,
					)}
				</DashboardGrid>
				<DashboardGrid gutter={false} minTile="24rem">
					{@render scorecardCard(
						'prediction_error',
						titles.predictions,
						record.scorecard.prediction_error,
						predictionsBody,
						(answer) => predictionReadings(answer, locale).sample,
					)}
					{@render scorecardCard(
						'poll_success',
						titles.feeds,
						record.scorecard.poll_success,
						feedsBody,
						(answer) => feedCheckSample(answer, locale),
					)}
				</DashboardGrid>
			{/if}
		</RecordGroup>

		{#if record}
			<RecordGroup>
				<section id="days-in-record" class="min-w-0">
					<RecordCard interactive title={titles.days} {stamp}>
						{#await record.health}
							<RecordSkeleton shape="table" />
						{:then result}
							{#if result.kind === 'answer'}
								{@const display = grid(result.answer)}
								{#if display.from && display.to && display.rows.length}
									<p class="mb-3">{daysSummary(result.answer)}</p>
									<div>
										<HourGrid
											label={titles.days}
											columns={display.columns}
											rows={display.rows}
											scale={{ label: '', steps: [] }}
											stateLabels={{ few: '', none: '', unmeasured: '' }}
										/>
										<ul
											class="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-small text-muted-foreground"
											role="list"
											aria-label={t('Day states', 'États des jours')}
										>
											{#each [...display.states] as state (state)}
												<li class="flex gap-2">
													<span aria-hidden="true" class="min-w-4 text-center"
														>{marks[state].text}</span
													>
													{labels[state]}
												</li>
											{/each}
										</ul>
									</div>
									{#if result.answer.days.length > display.columns.length}
										<p class="mt-3 text-small text-muted-foreground">
											{t(
												'The grid shows the last 14 days. The counts cover the full period.',
												'La grille montre les 14 derniers jours. Les totaux couvrent toute la période.',
											)}
										</p>
									{/if}
									<p class="mt-3">
										{t(
											'A day with a gap is left out of the figures that need it, and each figure says how many days it counted.',
											'Un jour avec une lacune est exclu des résultats qui en dépendent, et chaque résultat indique combien de jours il compte.',
										)}
									</p>
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
									rows={families.map((entry) => ({
										id: entry.family,
										label: entry.family_text?.[locale] ?? entry.family,
										href: `${methodHref}#${entry.id}`,
										since: entry.since,
									}))}
									columns={[
										{ key: 'since', header: t('Last changed', 'Dernier changement'), cell: since },
									]}
									value="since"
								/>
							{/if}
						{:else}<StateMark state="not_measured" {locale} />{/if}
					{/await}
				</RecordCard>
			</RecordGroup>
		{/if}
		{#if record && stamp}
			<RecordGroup>
				<AboutFigures
					title={term.about}
					fields={[
						{ key: 'period', label: term.period, text: dateRange(record.period, locale) },
						{
							key: 'counted',
							label: term.counted,
							text: t(
								`Every stop event in ${agencyLabel}’s timetable for these dates, and its live feeds.`,
								`Chaque passage prévu à l’horaire ${french.of} à ces dates, et ses flux en direct.`,
							),
						},
						{
							key: 'method',
							label: term.methodRow,
							text: null,
							link: { href: methodHref, label: term.method },
						},
						{
							key: 'source',
							label: term.source,
							text: operator ? term.feeds(operator) : null,
						},
					]}
				/>
			</RecordGroup>
		{/if}
	</div>
</RecordScreen>
