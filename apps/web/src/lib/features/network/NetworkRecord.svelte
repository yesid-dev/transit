<script lang="ts">
	import {
		recordPercent,
		tripOutcomeHeaders,
		tripOutcomeLabels,
		tripOutcomeNote,
		tripsRunBase,
	} from '#lib/site/presenter.ts';
	import { tripOutcomes } from '../record/tripOutcomes.ts';
	import FactList from '#lib/features/record/FactList.svelte';
	import FactRow from '#lib/features/record/FactRow.svelte';
	import RecordScreen from '#lib/features/record/RecordScreen.svelte';
	import RecordGroup from '#lib/features/record/RecordGroup.svelte';
	import { DashboardGrid } from '@yesid/ui/layout';
	import type { DataTableColumn } from '@yesid/ui/table';
	import type { Locale } from '#lib/i18n/index.ts';
	import type { loadNetworkRecord } from '#lib/server/networkRecord.ts';
	import type { RecordCell, RecordSeries } from '#lib/server/engine.ts';
	import { carryFrameState, frameHref } from '#lib/site/frameState.ts';
	import { localizeHref } from '#lib/i18n/routing.ts';
	import {
		countedUnit,
		dateRange,
		delayReading,
		methodEvidence,
		recordStamp,
		shortServiceDay,
	} from '#lib/site/presenter.ts';
	import {
		choose,
		measuredShare,
		pooledDays,
		punctualityWeighting,
		recordConnection,
		tally,
		timingBasis,
	} from '../record/recordText.ts';
	import { recordSectionLinks } from '../record/recordLinks.ts';
	import { recordState } from '../record/recordStates.ts';
	import { chartState } from '../record/charts/recordCharts.ts';
	import RecordChart from '../record/charts/RecordChart.svelte';
	import RecordChartToggle from '../record/charts/RecordChartToggle.svelte';
	import RecordAnswer from '../record/RecordAnswer.svelte';
	import RecordCard from '../record/RecordCard.svelte';
	import RecordEvidenceLine from '../record/RecordEvidenceLine.svelte';
	import RecordPending from '../record/RecordPending.svelte';
	import RecordActionGroup from '../record/RecordActionGroup.svelte';
	import ScreenTitle from '../record/ScreenTitle.svelte';
	import StateMark from '../record/StateMark.svelte';
	import AboutFigures from '../record/AboutFigures.svelte';
	import RecordDataTable from '../record/RecordDataTable.svelte';
	import NetworkRecordReading from './NetworkRecordReading.svelte';
	import { overviewCopy } from '../home/overviewRecord.copy.ts';

	let {
		record,
		subject,
		operator,
		locale,
		url,
	}: {
		record: ReturnType<typeof loadNetworkRecord> | null;
		subject: string;
		operator: string;
		locale: Locale;
		url: URL;
	} = $props();
	const t = (en: string, fr: string) => choose(locale, en, fr);
	const term = $derived(overviewCopy[locale]);
	const stamp = $derived(
		record ? { kind: 'record' as const, label: recordStamp(record.period, locale) } : undefined,
	);
	const pinned = $derived.by(() => {
		const link = new URL(url.pathname, url);
		if (record) link.searchParams.set('provider', record.city);
		return new URL(
			frameHref(link, { mode: 'record', period: record && { ...record.period, preset: null } }),
			url,
		);
	});
	const copy = $derived({
		bands: t('Early, on time and late', 'En avance, à l’heure et en retard'),
		delay: t('How late, how early', 'Retards et avances'),
		trend: t('Day by day', 'Jour par jour'),
		delivery: t('Trips run, cancelled and missing', 'Trajets effectués, annulés et manquants'),
		hours: t('By hour and weekday', 'Par heure et jour de la semaine'),
		crowding: t('Crowding', 'Places à bord'),
	});
	const csv = $derived(
		Object.entries(copy).map(([section, label]) => ({
			label,
			href: recordSectionLinks(pinned, section).csv,
		})),
	);
	let trendTable = $state(false);
	let hourTable = $state(false);
	let delayTable = $state(false);

	const number = (count: number | null | undefined) =>
		count == null ? t('Unknown', 'Inconnu') : tally(count, locale);
	function deliveryDay(day: string, cell: RecordSeries['cells'][number]) {
		// Every column comes from one breakdown, so the row adds up to Scheduled.
		const outcomes = cell.state === 'measured' ? tripOutcomes(cell.evidence) : null;
		const value = (key: Exclude<keyof NonNullable<typeof outcomes>, 'known'>) =>
			outcomes
				? number(outcomes[key])
				: recordState(chartState(cell.state === 'measured' ? 'unknown' : cell.state))[locale];
		return {
			id: day,
			label: shortServiceDay(day, locale),
			scheduled: value('scheduled'),
			noLiveData: value('noLiveData'),
			statusUnknown: value('statusUnknown'),
			ran: value('ran'),
			cancelled: value('cancelled'),
			missing: value('missing'),
		};
	}
	type DeliveryDay = ReturnType<typeof deliveryDay>;
	type CrowdingRow = { id: string; label: string; share: string };
	const headers = $derived(tripOutcomeHeaders(locale));
	const outcomeLabels = $derived(tripOutcomeLabels(locale));
	const deliveryColumns = $derived<DataTableColumn<DeliveryDay>[]>([
		{ key: 'scheduled', header: headers.scheduled, numeric: true, cell: scheduledCell },
		{ key: 'noLiveData', header: headers.noLiveData, numeric: true, cell: noLiveDataCell },
		{
			key: 'statusUnknown',
			header: headers.statusUnknown,
			numeric: true,
			cell: statusUnknownCell,
		},
		{ key: 'ran', header: headers.ran, numeric: true, cell: ranCell },
		{ key: 'cancelled', header: headers.cancelled, numeric: true, cell: cancelledCell },
		{ key: 'missing', header: headers.missing, numeric: true, cell: missingCell },
	]);
	const crowdingColumns = $derived<DataTableColumn<CrowdingRow>[]>([
		{
			key: 'share',
			header: t('Share of measured time', 'Part du temps mesuré'),
			numeric: true,
			cell: crowdingCell,
		},
	]);
	function sample(cell: Pick<RecordCell, 'evidence'>) {
		const count = cell.evidence.counts.classified;
		const days = countedUnit(cell.evidence.days_included.length, 'day', locale);
		return count == null ? days : `${countedUnit(count, 'event', locale)}, ${days}`;
	}

	function dayTypeReading(series: RecordSeries, weekday: boolean) {
		const matching = series.cells.filter(({ key }) =>
			weekday
				? key.day_type === 'weekday'
				: key.day_type === 'saturday' || key.day_type === 'sunday',
		);
		const measured = matching.filter((cell) => measuredShare(cell, 'on_time') != null);
		const sample = measured.reduce(
			(total, cell) => total + (cell.evidence.counts.classified ?? 0),
			0,
		);
		const onTime = measured.reduce((total, cell) => total + (cell.evidence.counts.on_time ?? 0), 0);
		return {
			share: sample > 0 ? onTime / sample : null,
			sample,
			days: new Set(measured.flatMap((cell) => cell.evidence.days_included)).size,
			state: chartState(
				matching.find((cell) => cell.state === 'too_few_to_judge')?.state ?? matching[0]?.state,
			),
		};
	}
</script>

{#snippet scheduledCell(row: DeliveryDay)}{row.scheduled}{/snippet}
{#snippet noLiveDataCell(row: DeliveryDay)}{row.noLiveData}{/snippet}
{#snippet statusUnknownCell(row: DeliveryDay)}{row.statusUnknown}{/snippet}
{#snippet ranCell(row: DeliveryDay)}{row.ran}{/snippet}
{#snippet cancelledCell(row: DeliveryDay)}{row.cancelled}{/snippet}
{#snippet missingCell(row: DeliveryDay)}{row.missing}{/snippet}
{#snippet crowdingCell(row: CrowdingRow)}{row.share}{/snippet}

<RecordScreen class="min-w-0">
	<RecordGroup
		><ScreenTitle title={t('Network health', 'Santé du réseau')} subtitle={subject} /></RecordGroup
	>
	<div data-slot="screen-content">
		<RecordGroup>
			<div data-slot="screen-answer">
				{#if !record || !stamp}
					<RecordAnswer
						{locale}
						value={null}
						state="not_measured"
						sentence={recordState('not_measured')[locale]}
					/>
				{:else}
					{#await record.punctuality}
						{#key record.punctuality}<RecordPending
								shape="answer"
								{locale}
								answer={record.punctuality}
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
						{:else if 'value' in result.answer}
							{@const answer = result.answer}
							{@const share = measuredShare(answer, 'on_time')}
							<RecordAnswer
								{locale}
								value={share == null ? null : recordPercent(share, locale)}
								state={share == null ? chartState(answer.state) : undefined}
								sentence={share == null
									? recordState(chartState(answer.state))[locale]
									: t(
											'of observed stop events were on time across the network.',
											'des passages observés aux arrêts étaient à l’heure sur le réseau.',
										)}
								time={stamp}
							>
								{#snippet meta()}
									{#if answer.evidence.counts.classified != null}
										<p>{term.counted}{t(':', ' :')} {sample(answer)}</p>
									{/if}
								{/snippet}
								{#snippet actions()}
									<RecordActionGroup {locale} href={pinned.href} files={csv}>
										{#snippet citation()}
											<p>
												Transit. {t('Network health', 'Santé du réseau')} ({record.city}). {dateRange(
													record.period,
													locale,
												)}. {methodEvidence(answer.evidence, locale)}
												{pinned.href}
											</p>
										{/snippet}
									</RecordActionGroup>
								{/snippet}
							</RecordAnswer>
						{/if}
					{/await}
				{/if}
			</div>
			{#if record && stamp}
				<DashboardGrid gutter={false} minTile="24rem" class="items-start">
					<NetworkRecordReading
						id="bands"
						title={copy.bands}
						{locale}
						{stamp}
						answer={record.punctuality}
						waiting="band-comparison"
					>
						{#snippet reading(result)}
							{#if !('cells' in result)}
								<RecordChart
									input={{ kind: 'bands', answer: result }}
									title={copy.bands}
									{locale}
									id="network-bands"
								/>
							{/if}
							<p class="mt-3 text-small text-muted-foreground">
								{t(
									'Early is more than 1 minute ahead of the timetable. Late is more than 5 minutes behind it.',
									'Un passage est en avance de plus d’une minute sur l’horaire ou en retard de plus de 5 minutes.',
								)}
							</p>
							<h3 class="mt-4 font-semibold">
								{t('Weekdays against weekends', 'Semaine et fin de semaine')}
							</h3>
							{#await record.dayTypes}
								{#key record.dayTypes}<RecordPending
										shape="comparison-facts"
										{locale}
										answer={record.dayTypes}
									/>{/key}
							{:then days}
								{#if days.kind === 'answer' && 'cells' in days.answer}
									<FactList>
										{#each [true, false] as weekday (weekday)}
											{@const reading = dayTypeReading(days.answer, weekday)}
											<FactRow
												label={weekday
													? t('Monday to Friday', 'Du lundi au vendredi')
													: t('Saturday and Sunday', 'Samedi et dimanche')}
												detail={reading.share == null
													? undefined
													: `${countedUnit(reading.sample, 'event', locale)}, ${countedUnit(reading.days, 'day', locale)}`}
											>
												{#if reading.share == null}<StateMark
														state={reading.state}
														{locale}
													/>{:else}
													<strong>{recordPercent(reading.share, locale)}</strong>
												{/if}
											</FactRow>
										{/each}
									</FactList>
								{:else if days.kind === 'busy'}<RecordPending {locale} busy />
								{:else}<p>{t('Unavailable', 'Indisponible')}</p>{/if}
							{/await}
						{/snippet}
					</NetworkRecordReading>
					<section id="delay" class="grid min-w-0">
						<RecordCard interactive title={copy.delay} {stamp}>
							{#await record.delayDistribution}
								{#key record.delayDistribution}<RecordPending
										shape="trend"
										{locale}
										answer={record.delayDistribution}
									/>{/key}
							{:then distribution}
								{#if distribution.kind === 'answer'}
									<div class="grid gap-3">
										<RecordChart
											input={{ kind: 'histogram', answer: distribution.answer }}
											title={copy.delay}
											{locale}
											id="network-delay"
											table={delayTable}
										/>
									</div>
								{:else if distribution.kind === 'busy'}<RecordPending {locale} busy />
								{:else}<p>{recordConnection.unreachable[locale]}</p>{/if}
							{/await}
							{#await record.punctuality then result}
								{#if result.kind === 'answer' && 'value' in result.answer && result.answer.state === 'measured'}
									{@const reading = result.answer}
									<div class="grid gap-4">
										<FactList>
											<FactRow
												label={t('Median', 'Médiane')}
												emphasis
												detail={t(
													'Half of the observed stop events were later than this.',
													'La moitié des passages observés ont eu lieu plus tard.',
												)}
											>
												{delayReading(reading.value.median_delay, locale)}
											</FactRow>
											<FactRow
												label={t('90th percentile', '90e centile')}
												emphasis
												detail={t(
													'1 observed stop event in 10 was later than this.',
													'Un passage observé sur dix a eu lieu plus tard.',
												)}
											>
												{delayReading(reading.value.p90_delay, locale)}
											</FactRow>
										</FactList>
									</div>
								{/if}
							{/await}
							{#snippet evidence()}
								{#await record.delayDistribution then result}
									{#if result.kind === 'answer'}
										<RecordEvidenceLine
											evidence={result.answer.evidence}
											sample={sample(result.answer)}
											{locale}
										/>
									{/if}
								{/await}
							{/snippet}
							{#snippet toggle()}
								{#await record.delayDistribution then result}
									{#if result.kind === 'answer'}
										{#if result.answer.cells.length}
											<RecordChartToggle
												bind:table={delayTable}
												controls="network-delay"
												{locale}
											/>
										{/if}
									{/if}
								{/await}
							{/snippet}
						</RecordCard>
					</section>
				</DashboardGrid>
				<!-- The trips table has six counts: a tile under 40rem would cut it off. -->
				<DashboardGrid gutter={false} minTile="40rem">
					<NetworkRecordReading
						id="trend"
						title={copy.trend}
						{locale}
						{stamp}
						answer={record.trend}
						fill
					>
						{#snippet reading(result)}
							{#if 'cells' in result}<RecordChart
									input={{ kind: 'trend', answer: result }}
									title={copy.trend}
									{locale}
									id="network-trend"
									table={trendTable}
									fill
								/>{/if}
						{/snippet}
						{#snippet control()}<RecordChartToggle
								bind:table={trendTable}
								controls="network-trend"
								{locale}
							/>{/snippet}
					</NetworkRecordReading>
					<NetworkRecordReading
						id="delivery"
						title={copy.delivery}
						{locale}
						{stamp}
						answer={record.delivery}
					>
						{#snippet reading(result)}
							{@const outcomes =
								!('cells' in result) && result.state === 'measured'
									? tripOutcomes(result.evidence)
									: null}
							{#if outcomes && !('cells' in result)}
								<dl class="mb-4 grid gap-2">
									<div class="flex flex-wrap justify-between gap-x-3">
										<dt>{term.delivery}</dt>
										<dd class="ml-auto text-right tabular-nums">
											<strong
												>{result.value.trips_run == null
													? t('Unknown', 'Inconnu')
													: recordPercent(result.value.trips_run, locale)}</strong
											>
											<span class="block text-small text-muted-foreground"
												>{tripsRunBase(outcomes.ran, outcomes.known, locale)}</span
											>
										</dd>
									</div>
									{#each [['cancelled', outcomes.cancelled], ['missing', outcomes.missing], ['statusUnknown', outcomes.statusUnknown], ['noLiveData', outcomes.noLiveData], ['scheduled', outcomes.scheduled]] as const as [key, count] (key)}
										<div class="flex flex-wrap justify-between gap-x-3">
											<dt>{outcomeLabels[key]}</dt>
											<dd class="ml-auto text-right tabular-nums">
												{#if key === 'scheduled'}<strong>{number(count)}</strong>{:else}{number(
														count,
													)}{/if}
											</dd>
										</div>
									{/each}
								</dl>
								<p class="mb-4 text-small text-muted-foreground">{tripOutcomeNote(locale)}</p>
							{:else}<StateMark
									state={chartState(result.state === 'measured' ? 'unknown' : result.state)}
									{locale}
								/>{/if}
							{#await record.deliveryDays then days}
								{#if days.kind === 'answer' && 'cells' in days.answer && days.answer.cells.length}
									{@const rows = days.answer.cells.flatMap((cell) =>
										typeof cell.key.day !== 'string' ? [] : [deliveryDay(cell.key.day, cell)],
									)}
									<RecordDataTable
										{locale}
										title={copy.delivery}
										rowHeader={t('Service date', 'Date de service')}
										columns={deliveryColumns}
										{rows}
										pageSize={rows.length > 7 ? 7 : undefined}
										scrollMinWidth="30rem"
									/>
								{:else if days.kind === 'busy'}<RecordPending {locale} busy />{/if}
							{/await}
						{/snippet}
					</NetworkRecordReading>
				</DashboardGrid>
				<NetworkRecordReading id="hours" title={copy.hours} {locale} {stamp} answer={record.hours}>
					{#snippet reading(result)}
						{#if 'cells' in result}<RecordChart
								input={{ kind: 'hours', answer: result }}
								title={copy.hours}
								{locale}
								id="network-hours"
								table={hourTable}
							/>{/if}
					{/snippet}
					{#snippet control()}<RecordChartToggle
							bind:table={hourTable}
							controls="network-hours"
							{locale}
						/>{/snippet}
				</NetworkRecordReading>
				<NetworkRecordReading
					id="crowding"
					title={copy.crowding}
					{locale}
					{stamp}
					answer={record.crowding}
				>
					{#snippet reading(result)}
						{#if !('cells' in result) && result.state === 'measured'}
							<RecordDataTable
								{locale}
								title={copy.crowding}
								rowHeader={t('Space on board', 'Place à bord')}
								columns={crowdingColumns}
								rows={[
									['empty', t('Empty', 'Vide')],
									['many_seats', t('Many seats available', 'Beaucoup de places assises libres')],
									['few_seats', t('Few seats available', 'Peu de places assises libres')],
									['standing', t('Standing room only', 'Places debout seulement')],
									['crushed', t('Limited standing room', 'Peu de places debout')],
									['full', t('Full', 'Plein')],
								].map(([id, label]) => {
									const share = result.value['crowding_' + id];
									return {
										id,
										label,
										share: share == null ? t('Unknown', 'Inconnu') : recordPercent(share, locale),
									};
								})}
								scrollMinWidth="24rem"
							/>
						{:else if result.state === 'not_tracked'}
							<p>
								{t(
									'Crowding is not tracked in this city.',
									'L’achalandage n’est pas suivi dans cette ville.',
								)}
							</p>
						{:else}<StateMark state={chartState(result.state)} {locale} />{/if}
					{/snippet}
				</NetworkRecordReading>
			{/if}
		</RecordGroup>
		{#if record && stamp}
			<RecordGroup>
				{#await record.punctuality then result}
					{@const answer =
						result.kind === 'answer' && 'value' in result.answer ? result.answer : null}
					<AboutFigures
						title={term.about}
						fields={[
							{
								key: 'period',
								label: term.period,
								text: dateRange(record.period, locale),
							},
							{
								key: 'counted',
								label: term.counted,
								text: answer
									? [
											`${sample(answer)}.`,
											punctualityWeighting[locale],
											record.period.from === record.period.to ? null : pooledDays[locale],
										]
											.filter(Boolean)
											.join(' ')
									: null,
							},
							{
								key: 'observed',
								label: term.observed,
								text: answer
									? [
											answer.evidence.share_observed == null
												? null
												: term.observedShare(
														recordPercent(answer.evidence.share_observed, locale),
														answer.evidence.counts.scheduled == null
															? undefined
															: tally(answer.evidence.counts.scheduled, locale),
													),
											timingBasis(answer.evidence.counts, locale),
											answer.coverage_note?.[locale],
										]
											.filter(Boolean)
											.join(' ')
									: null,
							},
							{
								key: 'means',
								label: term.means,
								text: term.definition,
							},
							{
								key: 'method',
								label: term.methodRow,
								text: null,
								link: {
									href: carryFrameState(localizeHref('/metrics', locale, record.city), pinned),
									label: term.method,
								},
							},
							{ key: 'source', label: term.source, text: term.feeds(operator) },
						]}
					/>
				{/await}
			</RecordGroup>
		{/if}
	</div>
</RecordScreen>
