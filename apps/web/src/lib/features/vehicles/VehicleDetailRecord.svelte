<script lang="ts">
	import { isSettled, type Awaitable, type Ready } from '#lib/site/ready.ts';
	import { page } from '$app/state';
	import type { Snippet } from 'svelte';
	import { agencyName, recordPercent, reportingGapsReading } from '#lib/site/presenter.ts';
	import RecordGroup from '#lib/features/record/RecordGroup.svelte';
	import { Button } from '@yesid/ui/button';
	import ChartDetails from '#lib/components/dataviz/chart/ChartDetails.svelte';
	import { DayStrip } from '@yesid/ui/chart';
	import RecordChart from '#lib/features/record/charts/RecordChart.svelte';
	import { DashboardGrid } from '@yesid/ui/layout';
	import type { Locale } from '#lib/i18n/index.ts';
	import type {
		EngineResult,
		RecordAnswer as Answer,
		RecordMeasure,
		RecordSeries,
	} from '#lib/server/engine.ts';
	import type { loadVehiclePage } from '#lib/server/vehicleRecord.ts';
	import {
		countedUnit,
		citeDates,
		dateRange,
		hoursReading,
		methodEvidence,
		citationSource,
		pageCitation,
		recordDate,
		recordStamp,
		sampleWithMinimum,
	} from '#lib/site/presenter.ts';
	import { transitDisplay } from '#lib/site/transitDisplayContext.ts';
	import { overviewCopy } from '#lib/features/home/overviewRecord.copy.ts';
	import AboutFigures from '#lib/features/record/AboutFigures.svelte';
	import RecordActionGroup from '#lib/features/record/RecordActionGroup.svelte';
	import CiteBlock from '#lib/features/record/CiteBlock.svelte';
	import RecordAnswer from '#lib/features/record/RecordAnswer.svelte';
	import RecordEvidenceLine from '#lib/features/record/RecordEvidenceLine.svelte';
	import RecordCard from '#lib/features/record/RecordCard.svelte';
	import RecordDataTable, {
		type RecordTableRow,
	} from '#lib/features/record/RecordDataTable.svelte';
	import RecordPending from '#lib/features/record/RecordPending.svelte';
	import type { RecordWaiting } from '../record/recordWaiting.ts';
	import RecordUnavailable from '#lib/features/record/RecordUnavailable.svelte';
	import RecordTableValue from '#lib/features/record/RecordTableValue.svelte';
	import StateMark from '#lib/features/record/StateMark.svelte';
	import { recordSectionLinks } from '#lib/features/record/recordLinks.ts';
	import { recordState, recordStateFor } from '#lib/features/record/recordStates.ts';
	import {
		lastGoodNote,
		recordConnection,
		tally,
		timingBasis,
	} from '#lib/features/record/recordText.ts';
	import { vehicleHref } from './vehicleLinks.ts';
	import {
		assignmentCaution,
		didNotReport,
		notTracked,
		sectionTitles,
		vehicleDayState,
		vehicleLines,
		vehicleReportDays,
		vehicleServiceDays,
		vehicleReading,
	} from './vehicleText.ts';

	let {
		data,
		url,
		locale,
		title,
		trackingDisabled,
		operator,
		titleBlock,
	}: {
		data: Ready<ReturnType<typeof loadVehiclePage>>;
		url: URL;
		locale: Locale;
		title: string;
		trackingDisabled: boolean;
		operator?: string;
		titleBlock: Snippet;
	} = $props();
	const display = transitDisplay();
	const t = (en: string, fr: string) => (locale === 'fr' ? fr : en);
	type VehicleLineRow = RecordTableRow & {
		count: string | null;
		state: ReturnType<typeof recordStateFor>;
	};
	function lineRows(answer: RecordSeries, trips: number | null): VehicleLineRow[] {
		return vehicleLines(answer).flatMap((cell) => {
			const line = cell.key.line;
			if (typeof line !== 'string') return [];
			const name = display.lineName(line);
			const count = cell.state === 'measured' ? (cell.value.vehicle_trips_run ?? null) : null;
			const share = count != null && trips ? recordPercent(count / trips, locale) : null;
			return [
				{
					id: line,
					label: name.name ?? name.label,
					plate: { code: name.number ?? line },
					href: vehicleHref(`/lines/${encodeURIComponent(line)}`, url, locale, data.city),
					detail: share ? t(`${share} of its trips`, `${share} de ses trajets`) : undefined,
					count: count != null ? tally(count, locale) : null,
					state: recordStateFor(cell.state),
				},
			];
		});
	}
	const term = $derived(overviewCopy[locale]);
	const noReport = $derived(
		t(
			'Did not report on these dates. That is not the same as out of service.',
			'Aucun signalement à ces dates. Cela ne veut pas dire que le véhicule était hors service.',
		),
	);
	const time = $derived(
		data.period ? { kind: 'record' as const, label: recordStamp(data.period, locale) } : undefined,
	);
	const records = $derived(
		data.sections.map(({ section, answer }) => ({
			section,
			answer,
			title:
				section === 'lines'
					? t('Lines and trips run', 'Lignes et trajets effectués')
					: section === 'completion'
						? t('Unfinished trips', 'Trajets non terminés')
						: sectionTitles[section][locale === 'fr' ? 1 : 0],
			citeTitle: sectionTitles[section][locale === 'fr' ? 1 : 0],
			links: recordSectionLinks(url, section),
		})),
	);
	const service = $derived(records.find(({ section }) => section === 'service'));
	// A reading that streamed in after the first paint keeps its room when it is a short state.
	const streamedService = $derived(service ? !isSettled(service.answer) : false);
	const lines = $derived(records.find(({ section }) => section === 'lines'));
	const timing = $derived(records.find(({ section }) => section === 'punctuality'));
	const dailyAnswer = $derived(data.days);
	const serviceFacts: RecordWaiting = { shape: 'facts', count: 3 };
	const lineShape: RecordWaiting = { shape: 'rows', count: 3, lines: 2, lead: 'plate' };
	const dayShape: RecordWaiting = { shape: 'table', rows: 7, header: false };
	type Reading = Awaitable<EngineResult<Answer>> | undefined;
	const measureOf = (result: EngineResult<Answer>) =>
		result.kind === 'answer' && 'value' in result.answer ? result.answer : null;
	// Readings that came drawn on the server are used at once; streamed ones when they arrive.
	let streamed = $state.raw<{ seed: Reading; value: RecordMeasure | null }[]>([]);
	const settledOf = (answer: Reading) =>
		answer === undefined
			? null
			: isSettled(answer)
				? measureOf(answer)
				: (streamed.find(({ seed }) => seed === answer)?.value ?? null);
	const settledService = $derived(settledOf(service?.answer));
	const settledTiming = $derived(settledOf(timing?.answer));
	$effect(() => {
		const answers = [service?.answer, timing?.answer];
		let current = true;
		streamed = [];
		for (const answer of answers) {
			if (answer === undefined || isSettled(answer)) continue;
			void answer.then((result) => {
				if (current) streamed = [...streamed, { seed: answer, value: measureOf(result) }];
			});
		}
		return () => {
			current = false;
		};
	});
	function sampleFor(answer: RecordMeasure | null) {
		const active = answer?.value.vehicle_days_in_service;
		const trips = answer?.value.vehicle_trips_run;
		return [
			trips == null ? null : countedUnit(trips, 'trip', locale),
			active == null ? null : countedUnit(active, 'day', locale) + t(' in service', ' en service'),
		]
			.filter(Boolean)
			.join(', ');
	}

	let shownDays = $state(7);
	let dayPage = $derived(data.period ? `${data.period.from}/${data.period.to}` : '');
	$effect(() => {
		if (dayPage) shownDays = 7;
	});

	function days(series: RecordSeries) {
		return data.period ? vehicleReportDays(series, data.period, locale) : [];
	}

	function punctualityBands(answer: RecordMeasure) {
		const {
			punctuality_classified: classified,
			punctuality_early: early,
			punctuality_on_time: on_time,
			punctuality_late: late,
		} = answer.evidence.counts;
		if (!classified || early == null || on_time == null || late == null) return null;
		return {
			...answer,
			evidence: { ...answer.evidence, counts: { classified, early, on_time, late } },
			value: { early: early / classified, on_time: on_time / classified, late: late / classified },
		};
	}
</script>

{#snippet absent(result: EngineResult<Answer>, shape?: RecordWaiting)}
	{#if result.kind === 'busy'}
		<RecordPending {locale} busy {shape} />
	{:else if result.kind === 'unreachable'}
		<RecordUnavailable {locale} retry={result.retry} />
	{:else if result.kind !== 'answer'}
		<p>{recordConnection[result.kind][locale]}</p>
	{:else if result.answer.state && result.answer.state !== 'measured'}
		<StateMark state={recordStateFor(result.answer.state)} {locale} />
	{:else}
		<StateMark state="unknown" {locale} />
	{/if}
{/snippet}

{#snippet actions()}
	<RecordActionGroup
		{locale}
		href={url.href}
		files={records.map(({ title, links }) => ({ label: title, href: links.csv }))}
	>
		{#snippet citation()}
			<CiteBlock
				{locale}
				text={pageCitation(
					title,
					data.period,
					url.href,
					locale,
					operator ? citationSource(operator, page.data.provider, locale) : null,
				)}
			/>
		{/snippet}
		{#snippet figures()}
			{#each records as { section, citeTitle, answer, links } (section)}
				{#await answer then result}
					{#if result.kind === 'answer'}
						<CiteBlock
							{locale}
							text={`Transit. ${title}. ${citeTitle}. ${data.period ? citeDates(data.period, locale) : ''}. ${methodEvidence(
								result.answer.evidence,
								locale,
							)} ${links.share}`}
						/>
					{/if}
				{/await}
			{/each}
		{/snippet}
	</RecordActionGroup>
{/snippet}

<RecordGroup class="gap-(--space-card-gap)">
	{@render titleBlock()}
	{#if trackingDisabled}
		<div data-slot="screen-answer">
			<RecordAnswer
				value={null}
				sentence={notTracked[locale]}
				state="not_tracked"
				{locale}
				{time}
			/>
		</div>
	{:else if service}
		{#await service.answer}
			<div class="vehicle-answer" data-slot="screen-answer">
				<RecordPending shape="answer" {locale} answer={service.answer} />
			</div>
		{:then result}
			{#if result.kind === 'busy'}
				<div class="vehicle-answer" data-slot="screen-answer">
					<RecordPending shape="answer" {locale} busy />
				</div>
			{:else if result.kind === 'unreachable' && result.retry}
				<div class="vehicle-answer" class:held={streamedService} data-slot="screen-answer">
					<RecordUnavailable {locale} retry={result.retry} />
				</div>
			{:else if result.kind === 'answer' && 'value' in result.answer && result.answer.state === 'measured' && (result.answer.value.vehicle_days_in_service ?? 0) > 0}
				{@const answer = result.answer}
				{@const serviceDays = vehicleServiceDays(answer, locale)}
				{@const serviceSample = sampleFor(answer)}

				<div class="vehicle-answer" data-slot="screen-answer">
					<RecordAnswer
						value={serviceDays.ratio}
						sentence={t(
							`${serviceDays.partial ? 'measured ' : ''}${serviceDays.total === 1 ? 'day' : 'days'} had vehicle ${data.id} in service.`,
							`${serviceDays.total < 2 ? 'jour' : 'jours'} ${serviceDays.partial ? (serviceDays.total < 2 ? 'mesuré ' : 'mesurés ') : ''}où le véhicule ${data.id} était en service.`,
						)}
						{locale}
						{time}
						{actions}
					>
						{#snippet meta()}
							{#if serviceSample}<p>
									{t('Counted: ', 'Ce qui est compté\u00a0: ')}{serviceSample}
								</p>{/if}
						{/snippet}
					</RecordAnswer>
					{#await dailyAnswer then daily}
						{#if daily?.kind === 'answer' && 'cells' in daily.answer}
							{@const missing = daily.answer.cells.filter(
								(cell) =>
									typeof cell.key.day === 'string' &&
									answer.evidence.days_included.includes(cell.key.day) &&
									vehicleDayState(cell) === 'not_reporting',
							).length}
							{#if missing}<p class="mt-2">
									{missing === 1
										? t(
												'On the other day it did not report. That is not the same as out of service.',
												'Le jour restant, il n’a transmis aucun signalement. Cela ne veut pas dire qu’il était hors service.',
											)
										: t(
												`On the other ${tally(missing, locale)} days it did not report. That is not the same as out of service.`,
												`Les ${tally(missing, locale)} autres jours, il n’a transmis aucun signalement. Cela ne veut pas dire qu’il était hors service.`,
											)}
								</p>{/if}
						{/if}
					{/await}
					{#if result.lastGood}<p>{lastGoodNote[locale]}</p>{/if}
				</div>
			{:else}
				{@const reading =
					result.kind === 'answer' && 'value' in result.answer ? result.answer : null}
				{@const noReports =
					reading?.state === 'measured' &&
					reading.evidence.days_included.length > 0 &&
					reading.value.vehicle_days_in_service === 0}
				{@const state = noReports ? 'not_reporting' : recordStateFor(reading?.state)}
				<!-- A short state keeps the waiting room, so the first screen does not move. -->
				<div class="vehicle-answer" class:held={streamedService} data-slot="screen-answer">
					<RecordAnswer
						value={null}
						{state}
						{locale}
						{time}
						sentence={noReports
							? reading && vehicleServiceDays(reading, locale).partial
								? t(
										'Did not report on the measured days. That is not the same as out of service.',
										'Aucun signalement les jours mesurés. Cela ne veut pas dire que le véhicule était hors service.',
									)
								: noReport
							: result.kind !== 'answer'
								? recordConnection[result.kind][locale]
								: state === 'not_tracked'
									? notTracked[locale]
									: recordState(state)[locale]}
						actions={result.kind === 'answer' ? actions : undefined}
					/>
					{#if result.kind === 'answer' && result.lastGood}<p>{lastGoodNote[locale]}</p>{/if}
				</div>
			{/if}
		{/await}
		<div id="service">
			<RecordCard
				interactive
				title={service.title}
				stamp={time}
				stampRule
				evidence={serviceEvidence}
			>
				<div class="service-card-body">
					{#await service.answer}<DashboardGrid gutter={false} minTile="18rem" class="items-start"
							><RecordPending {locale} shape={serviceFacts} answer={service.answer} /><RecordPending
								{locale}
								shape={lineShape}
							/></DashboardGrid
						>
					{:then result}
						{#if result.kind === 'answer' && 'value' in result.answer && result.answer.state === 'measured' && (result.answer.value.vehicle_days_in_service ?? 0) > 0}
							{@const answer = result.answer}
							{@const serviceDays = vehicleServiceDays(answer, locale)}
							{@const {
								vehicle_days_in_service: active,
								vehicle_hours_in_service: hours,
								vehicle_trips_run: trips,
								vehicle_lines_run: lineCount,
							} = answer.value}

							<DashboardGrid gutter={false} minTile="18rem" class="items-start">
								<dl class="flex min-w-0 flex-wrap gap-x-6 gap-y-3">
									<div>
										<dt>{t('Days in service', 'Jours en service')}</dt>
										<dd class="font-heading text-heading font-extrabold tabular-nums">
											{serviceDays.ratio}
										</dd>
										<dd class="text-small text-muted-foreground">
											{serviceDays.partial
												? t('of the measured days', 'parmi les jours mesurés')
												: t(
														'days with a report on a trip',
														'jours avec un signalement pendant un trajet',
													)}
										</dd>
									</div>
									{#if hours != null}<div>
											<dt>{t('Hours in service', 'Heures en service')}</dt>
											<dd class="font-heading text-heading font-extrabold tabular-nums">
												{hoursReading(hours, locale)}
											</dd>
											{#if active}<dd class="text-small text-muted-foreground">
													{t(
														`${hoursReading(hours / active, locale)} on a day in service`,
														`${hoursReading(hours / active, locale)} par jour en service`,
													)}
												</dd>{/if}
										</div>{/if}
									{#if trips != null}<div>
											<dt>{t('Trips', 'Trajets')}</dt>
											<dd class="font-heading text-heading font-extrabold tabular-nums">
												{tally(trips, locale)}
											</dd>
											{#if lineCount != null}<dd class="text-small text-muted-foreground">
													{t(
														`on ${countedUnit(lineCount, 'line', locale)}`,
														`sur ${countedUnit(lineCount, 'line', locale)}`,
													)}
												</dd>{/if}
										</div>{/if}
								</dl>
								{#if lines}
									<section
										id="lines"
										class="vehicle-lines grid min-w-0 gap-2"
										aria-labelledby="vehicle-lines-title"
									>
										<h3 id="vehicle-lines-title" class="font-semibold">{lines.title}</h3>
										{#await lines.answer}
											<RecordPending {locale} shape={lineShape} answer={lines.answer} />
										{:then series}
											{#if series.kind === 'answer' && 'cells' in series.answer && series.answer.cells.length}
												{@const rows = lineRows(series.answer, trips)}
												{#snippet lineCount(row: VehicleLineRow)}
													<RecordTableValue {locale} text={row.count} state={row.state} />
												{/snippet}
												<RecordDataTable
													{locale}
													title={lines.title}
													rowHeader={t('Line', 'Ligne')}
													{rows}
													pageSize={rows.length > 3 ? 3 : undefined}
													columns={[
														{
															key: 'trips',
															header: t('Trips', 'Trajets'),
															numeric: true,
															cell: lineCount,
														},
													]}
													value="trips"
												/>
												{#if series.lastGood}<p>{lastGoodNote[locale]}</p>{/if}
											{:else}{@render absent(series, lineShape)}{/if}
										{/await}
									</section>
								{/if}
							</DashboardGrid>
						{:else}<div class="service-state" class:held={streamedService}>
								{@render absent(result, serviceFacts)}
							</div>{/if}{/await}
				</div>
			</RecordCard>
		</div>
		<RecordCard interactive title={t('Day by day', 'Jour par jour')} stamp={time} stampRule>
			{#await dailyAnswer}
				{#if dailyAnswer}<RecordPending {locale} shape={dayShape} answer={dailyAnswer} />{/if}
			{:then result}
				{#if result?.kind === 'answer' && 'cells' in result.answer}
					{@const cells = days(result.answer)}
					<div class="day-strip-wide">
						<ChartDetails
							label={t('Days in service', 'Jours en service')}
							targets="[data-slot='day-strip-cell']"
							readings={cells.slice(0, shownDays).map((day) => ({
								key: day.id,
								heading: recordDate(day.id, locale),
								rows: [
									{
										label: t('Hours in service', 'Heures en service'),
										value:
											day.state === 'not_reporting'
												? recordState('not_reporting')[locale]
												: (day.report?.value ?? recordState('not_measured')[locale]),
									},
								],
							}))}
						>
							<DayStrip
								label={t('Days in service', 'Jours en service')}
								cells={cells.slice(0, shownDays)}
								reportedLabel={t(
									'In service: its hours with reports that day',
									'En service\u00a0: heures avec signalements ce jour-là',
								)}
								missingLabel={recordState('not_measured')[locale]}
							/>
						</ChartDetails>
					</div>
					<ol
						class="day-rows"
						aria-label={t('Hours in service by day', 'Heures en service par jour')}
						data-slot="vehicle-day-rows"
					>
						{#each cells.slice(0, shownDays) as day (day.id)}
							<li>
								<span class="day-rows-day">{day.label}</span>
								{#if day.state === 'in_service' && day.report}<span
										class="day-rows-track"
										aria-hidden="true"
										><span class="day-rows-bar" style:inline-size={`${day.report.fraction * 100}%`}
										></span></span
									><span class="day-rows-value">{day.report.value}</span>
								{:else}{@const mark = recordState(
										day.state === 'not_reporting' ? 'not_reporting' : 'not_measured',
									)}<span class="day-rows-state" data-record-state={day.state}
										><span class="font-mono text-muted-foreground" aria-hidden="true"
											>{mark.glyph}</span
										>
										{mark[locale]}</span
									>{/if}
							</li>
						{/each}
					</ol>
					{#if cells.some((entry) => entry.state === 'not_reporting')}
						<p class="mt-2 flex items-baseline gap-2 text-small text-muted-foreground">
							<StateMark state="not_reporting" {locale} hiddenLabel />
							{didNotReport[locale]}
						</p>
					{/if}
					{#if cells.length > shownDays}<Button
							variant="outline"
							class="mt-2 min-h-11"
							onclick={() => (shownDays += 7)}
							>{t('Show more days', 'Afficher plus de jours')}</Button
						>{/if}
					{#if result.lastGood}<p>{lastGoodNote[locale]}</p>{/if}
				{:else if result}{@render absent(result, dayShape)}{/if}
			{/await}
			{#snippet evidence()}
				{#await dailyAnswer then result}
					{#if result?.kind === 'answer' && 'cells' in result.answer}
						{@const entries = days(result.answer)}
						{@const reported = entries.filter((entry) => entry.state === 'in_service').length}
						{@const measured = entries.filter((entry) => entry.state !== 'not_measured').length}
						{@const denominator = countedUnit(
							measured,
							measured < entries.length ? 'measured-day' : 'day',
							locale,
						)}
						<RecordEvidenceLine
							evidence={result.answer.evidence}
							sample={measured
								? t(
										`${tally(reported, locale)} of ${denominator} in service`,
										`${tally(reported, locale)} sur ${denominator} en service`,
									)
								: null}
							{locale}
						/>
					{/if}
				{/await}
			{/snippet}
		</RecordCard>

		<DashboardGrid gutter={false} minTile="19rem" class="items-start">
			{#each records.filter(({ section }) => section === 'reporting') as { section, title: heading, answer } (section)}
				<div id={section} class="grid min-w-0">
					<RecordCard title={heading} stamp={time} stampRule>
						{#await answer}<RecordPending {locale} {answer} shape={serviceFacts} />
						{:then result}
							{#if result.kind === 'answer' && 'value' in result.answer}
								{@const reading = result.answer}
								{@const counts = reading.evidence.counts}
								{#if result.lastGood}<p>{lastGoodNote[locale]}</p>{/if}
								{#if reading.state === 'measured'}
									{#if counts.reporting_gaps != null}<strong class="block text-title tabular-nums"
											>{tally(counts.reporting_gaps, locale)}</strong
										>{/if}
									<p>
										{reportingGapsReading(
											reading.value.vehicle_reporting_gaps_per_100_hours,
											counts.reporting_gaps,
											locale,
											counts.silent_hours,
										) ?? vehicleReading(reading, 'vehicle_reporting_gaps_per_100_hours', locale)}
									</p>
								{:else}{@render absent(result, serviceFacts)}{/if}
							{:else}{@render absent(result, serviceFacts)}{/if}
						{/await}
						{#snippet evidence()}
							{#await answer then result}
								{#if result.kind === 'answer' && 'value' in result.answer}
									{@const hours = result.answer.evidence.counts.hours_in_service}
									<RecordEvidenceLine
										evidence={result.answer.evidence}
										sample={hours != null
											? t(
													`${hoursReading(hours, locale)} in service`,
													`${hoursReading(hours, locale)} en service`,
												)
											: null}
										{locale}
									/>
								{/if}
							{/await}
						{/snippet}
					</RecordCard>
				</div>
			{/each}
		</DashboardGrid>
		{#if timing}
			<div id="punctuality">
				<RecordCard title={timing.title} stamp={time} stampRule>
					<DashboardGrid gutter={false} minTile="18rem">
						<p class="font-semibold">{assignmentCaution[locale]}</p>
						<div class="grid min-w-0 gap-2">
							{#await timing.answer}<RecordPending {locale} shape="bands" answer={timing.answer} />
							{:then result}
								{#if result.kind === 'answer' && 'value' in result.answer}
									{@const reading = result.answer}
									{@const count = reading.evidence.counts.punctuality_classified}
									{@const minimum = reading.info?.find(
										({ id }) => id === 'vehicle_on_time',
									)?.minimum_sample}
									{#if result.lastGood}<p>{lastGoodNote[locale]}</p>{/if}
									{#if reading.state === 'measured' && reading.value.vehicle_on_time != null && count}
										<p>
											<strong class="text-title tabular-nums"
												>{recordPercent(reading.value.vehicle_on_time, locale)}</strong
											>
											{t(
												'of recorded stop arrivals were on time.',
												'des passages enregistrés étaient à l’heure.',
											)}
										</p>
										{@const chart = punctualityBands(reading)}
										{#if chart}<RecordChart
												input={{ kind: 'bands', answer: chart }}
												title={timing.title}
												{locale}
												id="vehicle-punctuality-bands"
											/>{/if}
									{:else}
										{@render absent(result, serviceFacts)}
										{#if reading.state === 'too_few_to_judge' && count != null}
											<p>
												{minimum == null
													? countedUnit(count, 'event', locale)
													: sampleWithMinimum(countedUnit(count, 'event', locale), minimum, locale)}
											</p>
										{/if}
									{/if}
								{:else}{@render absent(result, serviceFacts)}{/if}
							{/await}
						</div>
					</DashboardGrid>
					{#snippet evidence()}
						{#await timing.answer then result}
							{#if result.kind === 'answer' && 'value' in result.answer}
								{@const count = result.answer.evidence.counts.punctuality_classified}
								<RecordEvidenceLine
									evidence={result.answer.evidence}
									sample={count ? countedUnit(count, 'event', locale) : null}
									{locale}
								/>
							{/if}
						{/await}
					{/snippet}
				</RecordCard>
			</div>
		{/if}
	{:else}
		<div data-slot="screen-answer">
			<RecordAnswer
				value={null}
				state="not_measured"
				{locale}
				sentence={t('Choose dates to see the record.', 'Choisissez des dates pour voir le bilan.')}
			/>
		</div>
	{/if}
</RecordGroup>
{#if service && !trackingDisabled}
	<RecordGroup class="gap-(--space-card-gap)">
		{@render aboutFigures(sampleFor(settledService), settledTiming?.evidence ?? null)}
	</RecordGroup>
{/if}

{#snippet serviceEvidence()}
	{#if settledService}
		<RecordEvidenceLine
			evidence={settledService.evidence}
			sample={sampleFor(settledService)}
			{locale}
		/>
	{/if}
{/snippet}

{#snippet aboutFigures(serviceSample: string, evidence: RecordMeasure['evidence'] | null)}
	<AboutFigures
		title={t('About these figures', 'À propos de ces chiffres')}
		fields={[
			{
				key: 'period',
				label: t('Period', 'Période'),
				text: data.period ? dateRange(data.period, locale) : null,
			},
			{
				key: 'counted',
				label: term.counted,
				text: serviceSample ? `${serviceSample}.` : null,
			},
			{
				key: 'service',
				label: t('In service means', 'En service'),
				text: t(
					'Days count dates with a position reported on a trip.',
					'Les jours comptés sont ceux où une position a été signalée pendant un trajet.',
				),
			},
			{
				key: 'gaps',
				label: t('Stopped reporting means', 'Interruption de signalement'),
				text: t(
					'A long pause between two position reports on the same trip. The feed cannot tell whether the vehicle kept running.',
					'Une longue interruption entre deux signalements de position sur le même trajet. Le flux n’indique pas si le véhicule a continué de rouler.',
				),
			},
			{
				key: 'unfinished',
				label: t('Trips cut short', 'Trajets écourtés'),
				text: t(
					'Not tracked: the live feeds do not show reliably when a trip ends early.',
					'Non suivis\u00a0: les flux en direct n’indiquent pas de façon fiable qu’un trajet se termine plus tôt.',
				),
			},
			{
				key: 'observed',
				label: t('Observed', 'Observations'),
				text: evidence
					? [
							evidence.counts.classified == null
								? null
								: t(
										`${countedUnit(evidence.counts.classified, 'event', locale)} on the trips it reported.`,
										`${countedUnit(evidence.counts.classified, 'event', locale)} sur les trajets qu’il a signalés.`,
									),
							timingBasis(evidence.counts, locale),
						]
							.filter(Boolean)
							.join(' ')
					: null,
			},
			{ key: 'means', label: term.means, text: term.definition },
			{
				key: 'method',
				label: t('Method', 'Méthode'),
				text: null,
				link: { href: vehicleHref('/metrics', url, locale, data.city), label: term.method },
			},
			{
				key: 'error',
				label: t('Seen an error?', 'Vous avez vu une erreur?'),
				text: null,
				link: {
					href: vehicleHref('/metrics', url, locale, data.city) + '#about-transit',
					label: t('About Transit', 'À propos de Transit'),
				},
			},
			{
				key: 'source',
				label: term.source,
				text: operator ? term.feeds(agencyName(operator, page.data.provider)) : null,
			},
		]}
	/>
{/snippet}

<style>
	/* The answer and the first card keep their waiting room while they wait. A short state gives
	   it back only when it was drawn with the page; one that streams in keeps it, so the first
	   screen does not move under the reader. A reading releases it. */
	.vehicle-answer:is(.held, :has(:global([data-record-pending], [data-record-busy]))) {
		min-block-size: 13.25rem;
	}
	.service-card-body:has(:global([data-record-pending], [data-record-busy]), .service-state.held) {
		min-block-size: 16rem;
	}
	@media (width < 40rem) {
		.vehicle-answer:is(.held, :has(:global([data-record-pending], [data-record-busy]))) {
			min-block-size: 14.5rem;
		}
		.service-card-body:has(
			:global([data-record-pending], [data-record-busy]),
			.service-state.held
		) {
			min-block-size: 28rem;
		}
	}

	/* A phone reads the week as one row per day: the day, its bar on one scale, its hours. */
	.day-rows {
		display: none;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	@container (width < 28rem) {
		.day-strip-wide {
			display: none;
		}
		.day-rows {
			display: grid;
			gap: 0.5rem;
		}
	}
	/* The day and the hours keep fixed widths, so every bar shares one scale; with large text a
	   state that cannot fit beside its day moves under it. */
	.day-rows > li {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.25rem 0.75rem;
	}
	.day-rows-day {
		flex: 0 0 4.5em;
		font-size: var(--text-small);
		color: var(--muted-foreground);
	}
	.day-rows-track {
		flex: 1 1 4rem;
		display: block;
		block-size: 0.75rem;
		border-radius: var(--radius-sm);
		background: var(--muted);
	}
	.day-rows-bar {
		display: block;
		block-size: 100%;
		border-radius: var(--radius-sm);
		background: var(--foreground);
	}
	.day-rows-value {
		font-family: var(--font-mono);
		font-size: var(--text-small);
		font-variant-numeric: tabular-nums;
		font-weight: 600;
		flex: 0 0 4.5em;
		text-align: end;
	}
	/* The state wraps between words, never inside one, at large text. */
	.day-rows-state {
		flex: 1 1 8em;
		font-size: var(--text-small);
		font-weight: 600;
		overflow-wrap: normal;
		word-break: normal;
	}
	@media (forced-colors: active) {
		.day-rows-bar {
			background: CanvasText;
		}
	}
</style>
