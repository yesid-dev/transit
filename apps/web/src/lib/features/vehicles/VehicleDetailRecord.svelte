<script lang="ts">
	import RecordGroup from '#lib/features/record/RecordGroup.svelte';
	import { Button } from '@yesid/ui/button';
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
		dateRange,
		hoursReading,
		methodEvidence,
		recordStamp,
		sampleWithMinimum,
	} from '#lib/site/presenter.ts';
	import { transitDisplay } from '#lib/site/transitDisplayContext.ts';
	import { overviewCopy } from '#lib/features/home/overviewRecord.copy.ts';
	import AboutFigures from '#lib/features/record/AboutFigures.svelte';
	import RecordActionGroup from '#lib/features/record/RecordActionGroup.svelte';
	import RecordAnswer from '#lib/features/record/RecordAnswer.svelte';
	import RecordEvidenceLine from '#lib/features/record/RecordEvidenceLine.svelte';
	import RecordCard from '#lib/features/record/RecordCard.svelte';
	import RecordDataTable, {
		type RecordTableRow,
	} from '#lib/features/record/RecordDataTable.svelte';
	import RecordPending from '#lib/features/record/RecordPending.svelte';
	import RecordTableValue from '#lib/features/record/RecordTableValue.svelte';
	import StateMark from '#lib/features/record/StateMark.svelte';
	import { recordSectionLinks } from '#lib/features/record/recordLinks.ts';
	import { recordState, recordStateFor } from '#lib/features/record/recordStates.ts';
	import {
		coverageText,
		lastGoodNote,
		percent,
		pooledDays,
		punctualityWeighting,
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
	}: {
		data: ReturnType<typeof loadVehiclePage>;
		url: URL;
		locale: Locale;
		title: string;
		trackingDisabled: boolean;
		operator?: string;
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
			const share = count != null && trips ? percent(count / trips, locale) : null;
			return [
				{
					id: line,
					label: name.name ?? name.label,
					plate: { code: name.number ?? line },
					href: vehicleHref(`/lines/${encodeURIComponent(line)}`, url, locale, data.city),
					detail: share ? t(`${share} of its trips`, `${share} de ses trajets`) : undefined,
					count: count != null ? countedUnit(count, 'trip', locale) : null,
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
					? t('Lines and trips it ran', 'Lignes et trajets effectués')
					: section === 'completion'
						? t('Trips it did not finish', 'Trajets non terminés')
						: sectionTitles[section][locale === 'fr' ? 1 : 0],
			citeTitle: sectionTitles[section][locale === 'fr' ? 1 : 0],
			links: recordSectionLinks(url, section),
		})),
	);
	const service = $derived(records.find(({ section }) => section === 'service'));
	const lines = $derived(records.find(({ section }) => section === 'lines'));
	const timing = $derived(records.find(({ section }) => section === 'punctuality'));
	const dailyAnswer = $derived(data.days);

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

{#snippet absent(result: EngineResult<Answer>)}
	{#if result.kind === 'busy'}
		<RecordPending {locale} busy />
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
			{#each records as { section, citeTitle, answer, links } (section)}
				{#await answer then result}
					{#if result.kind === 'answer'}
						<p>
							Transit. {title}. {citeTitle}. {data.period ? dateRange(data.period, locale) : ''}. {methodEvidence(
								result.answer.evidence,
								locale,
							)}
							{links.share}
						</p>
					{/if}
				{/await}
			{/each}
		{/snippet}
	</RecordActionGroup>
{/snippet}

{#if trackingDisabled}
	<RecordGroup>
		<div data-slot="screen-answer">
			<RecordAnswer
				value={null}
				sentence={notTracked[locale]}
				state="not_tracked"
				{locale}
				{time}
			/>
		</div>
	</RecordGroup>
{:else if service}
	{#await service.answer}
		<RecordGroup
			><div data-slot="screen-answer">
				<RecordPending {locale} answer={service.answer} />
			</div></RecordGroup
		>
	{:then result}
		{#if result.kind === 'busy'}
			<RecordGroup><div data-slot="screen-answer"><RecordPending {locale} busy /></div></RecordGroup
			>
		{:else if result.kind === 'answer' && 'value' in result.answer && result.answer.state === 'measured' && (result.answer.value.vehicle_days_in_service ?? 0) > 0}
			{@const answer = result.answer}
			{@const serviceDays = vehicleServiceDays(answer, locale)}
			{@const {
				vehicle_days_in_service: active,
				vehicle_hours_in_service: hours,
				vehicle_trips_run: trips,
				vehicle_lines_run: lineCount,
			} = answer.value}
			{@const inService =
				active != null
					? t(
							`${countedUnit(active, 'day', locale)} in service`,
							`${countedUnit(active, 'day', locale)} en service`,
						)
					: null}
			{@const serviceSample = [trips == null ? null : countedUnit(trips, 'trip', locale), inService]
				.filter(Boolean)
				.join(', ')}
			<RecordGroup>
				<div data-slot="screen-answer">
					<RecordAnswer
						value={serviceDays.ratio}
						sentence={t(
							`${serviceDays.partial ? 'measured ' : ''}${serviceDays.total === 1 ? 'day' : 'days'} had vehicle ${data.id} in service.`,
							`${serviceDays.total === 1 ? 'jour' : 'jours'} ${serviceDays.partial ? (serviceDays.total === 1 ? 'mesuré ' : 'mesurés ') : ''}où le véhicule ${data.id} était en service.`,
						)}
						{locale}
						{time}
						{actions}
					>
						{#snippet meta()}
							{#if serviceSample}<p>{t('Counted: ', 'Décompte : ')}{serviceSample}</p>{/if}
							<p class="font-mono text-small text-muted-foreground">
								{methodEvidence(answer.evidence, locale, true)}
							</p>
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
				<div id="service">
					<RecordCard interactive title={service.title} stamp={time}>
						<DashboardGrid gutter={false} minTile="18rem">
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
										<RecordPending {locale} answer={lines.answer} />
									{:then series}
										{#if series.kind === 'answer' && 'cells' in series.answer && series.answer.cells.length}
											{#snippet lineCount(row: VehicleLineRow)}
												<RecordTableValue {locale} text={row.count} state={row.state} />
											{/snippet}
											<RecordDataTable
												{locale}
												title={lines.title}
												rowHeader={t('Line', 'Ligne')}
												rows={lineRows(series.answer, trips)}
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
										{:else}{@render absent(series)}{/if}
									{/await}
								</section>
							{/if}
						</DashboardGrid>
						{#snippet evidence()}
							<RecordEvidenceLine evidence={answer.evidence} sample={serviceSample} {locale} />
						{/snippet}
					</RecordCard>
				</div>
				<RecordCard interactive title={t('Day by day', 'Jour après jour')} stamp={time}>
					{#await dailyAnswer}
						{#if dailyAnswer}<RecordPending {locale} answer={dailyAnswer} />{/if}
					{:then result}
						{#if result?.kind === 'answer' && 'cells' in result.answer}
							{@const cells = days(result.answer)}
							<DayStrip
								label={t('Days in service', 'Jours en service')}
								cells={cells.slice(0, shownDays)}
								reportedLabel={t(
									'In service: its hours with reports that day',
									'En service : heures avec signalements ce jour-là',
								)}
								missingLabel={recordState('not_measured')[locale]}
							/>
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
						{:else if result}{@render absent(result)}{/if}
					{/await}
					{#snippet evidence()}
						{#await dailyAnswer then result}
							{#if result?.kind === 'answer' && 'cells' in result.answer}
								{@const entries = days(result.answer)}
								{@const reported = entries.filter((entry) => entry.state === 'in_service').length}
								{@const measured = entries.filter((entry) => entry.state !== 'not_measured').length}
								<RecordEvidenceLine
									evidence={result.answer.evidence}
									sample={measured
										? t(
												`${countedUnit(reported, 'day', locale)} in service of ${tally(measured, locale)}${measured < entries.length ? ' measured days' : ''}`,
												`${countedUnit(reported, 'day', locale)} en service sur ${tally(measured, locale)}${measured < entries.length ? ' jours mesurés' : ''}`,
											)
										: null}
									{locale}
								/>
							{/if}
						{/await}
					{/snippet}
				</RecordCard>

				<DashboardGrid gutter={false} minTile="19rem">
					{#each records.filter(({ section }) => section === 'reporting' || section === 'completion') as { section, title: heading, answer } (section)}
						<div id={section} class="grid min-w-0">
							<RecordCard title={heading} stamp={time}>
								{#await answer}<RecordPending {locale} {answer} />
								{:then result}
									{#if result.kind === 'answer' && 'value' in result.answer}
										{@const reading = result.answer}
										{@const counts = reading.evidence.counts}
										{#if result.lastGood}<p>{lastGoodNote[locale]}</p>{/if}
										{#if section === 'completion' && reading.state === 'not_tracked'}
											<p class="flex flex-wrap items-baseline gap-x-2 font-semibold">
												<StateMark state="not_tracked" {locale} hiddenLabel />{t(
													'Not tracked',
													'Non suivi',
												)}
											</p>
											<p>
												{t(
													'The live feeds do not show reliably when a trip ends early, so trips not finished are not tracked.',
													'Les flux en direct ne montrent pas de façon fiable quand un trajet se termine tôt, alors les trajets non terminés ne sont pas suivis.',
												)}
											</p>
										{:else if section === 'reporting' && reading.state === 'measured'}
											{#if counts.reporting_gaps != null}<strong
													class="block text-title tabular-nums"
													>{tally(counts.reporting_gaps, locale)}</strong
												>{/if}
											<p>
												{vehicleReading(reading, 'vehicle_reporting_gaps_per_100_hours', locale)}
												{t(
													'interruptions per 100 hours in service',
													'interruptions par 100 heures en service',
												)}
											</p>
										{:else}{@render absent(result)}{/if}
									{:else}{@render absent(result)}{/if}
								{/await}
								{#snippet evidence()}
									{#await answer then result}
										{#if result.kind === 'answer' && 'value' in result.answer}
											{@const hours = result.answer.evidence.counts.hours_in_service}
											<RecordEvidenceLine
												evidence={result.answer.evidence}
												sample={section === 'reporting' && hours != null
													? t(
															`${hoursReading(hours, locale)} in service`,
															`${hoursReading(hours, locale)} en service`,
														)
													: section === 'completion' && trips != null
														? countedUnit(trips, 'trip', locale)
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
						<RecordCard title={timing.title} stamp={time}>
							<DashboardGrid gutter={false} minTile="18rem">
								<p class="font-semibold">{assignmentCaution[locale]}</p>
								<div class="grid min-w-0 gap-2">
									{#await timing.answer}<RecordPending {locale} answer={timing.answer} />
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
														>{percent(reading.value.vehicle_on_time, locale)}</strong
													>
													{t(
														'of observed stop events were on time.',
														'des passages observés étaient à l’heure.',
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
												{@render absent(result)}
												{#if reading.state === 'too_few_to_judge' && count != null}
													<p>
														{minimum == null
															? countedUnit(count, 'event', locale)
															: sampleWithMinimum(
																	countedUnit(count, 'event', locale),
																	minimum,
																	locale,
																)}
													</p>
												{/if}
											{/if}
										{:else}{@render absent(result)}{/if}
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
			</RecordGroup>
			{#await timing?.answer then result}
				<RecordGroup>
					{@const evidence =
						result?.kind === 'answer' && 'value' in result.answer ? result.answer.evidence : null}
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
								text: [
									serviceSample ? `${serviceSample}.` : null,
									punctualityWeighting[locale],
									data.period?.from !== data.period?.to ? pooledDays[locale] : null,
								]
									.filter(Boolean)
									.join(' '),
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
									'More than a minute between successive position reports on the same trip. The feed cannot tell whether the vehicle kept running.',
									'Plus d’une minute entre deux signalements successifs sur le même trajet. Le flux n’indique pas si le véhicule a continué de rouler.',
								),
							},
							{
								key: 'observed',
								label: t('Observed', 'Observations'),
								text: evidence
									? [
											coverageText(evidence, locale).replace(/([^.!?])$/, '$1.'),
											timingBasis(evidence.counts, locale),
										]
											.filter(Boolean)
											.join(' ')
									: null,
							},
							{ key: 'means', label: term.means, text: term.definition },
							{
								key: 'versions',
								label: t('Versions', 'Versions'),
								text: methodEvidence(answer.evidence, locale),
							},
							{ key: 'source', label: term.source, text: operator ? term.feeds(operator) : null },
						]}
						versionsLink={{
							href: vehicleHref('/metrics', url, locale, data.city),
							label: term.method,
						}}
					/>
				</RecordGroup>
			{/await}
		{:else}
			{@const reading = result.kind === 'answer' && 'value' in result.answer ? result.answer : null}
			{@const noReports =
				reading?.state === 'measured' &&
				reading.evidence.days_included.length > 0 &&
				reading.value.vehicle_days_in_service === 0}
			{@const state = noReports ? 'not_reporting' : recordStateFor(reading?.state)}
			<RecordGroup>
				<div data-slot="screen-answer">
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
			</RecordGroup>
		{/if}
	{/await}
{:else}
	<RecordGroup>
		<div data-slot="screen-answer">
			<RecordAnswer
				value={null}
				state="not_measured"
				{locale}
				sentence={t('Choose dates to see the record.', 'Choisissez des dates pour voir le bilan.')}
			/>
		</div>
	</RecordGroup>
{/if}
