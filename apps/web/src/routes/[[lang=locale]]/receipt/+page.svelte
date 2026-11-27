<script lang="ts">
	import RecordGroup from '#lib/features/record/RecordGroup.svelte';
	import RecordEvidenceLine from '#lib/features/record/RecordEvidenceLine.svelte';
	import RecordScreen from '#lib/features/record/RecordScreen.svelte';
	import { page } from '$app/state';
	import { SvelteURL } from 'svelte/reactivity';
	import { RoutePlate } from '@yesid/ui/brand';
	import { DashboardGrid, Surface } from '@yesid/ui/layout';
	import type { DataTableColumn } from '@yesid/ui/table';
	import { localizeHref } from '#lib/i18n/index.ts';
	import { alertDetailsLimit } from '#lib/features/alerts/alertRecord.ts';
	import { recordNoticeCards } from '#lib/features/alerts/alertCards.ts';
	import RecordRanking from '#lib/features/home/RecordRanking.svelte';
	import { overviewCopy } from '#lib/features/home/overviewRecord.copy.ts';
	import { previewRows, recordCounts } from '#lib/features/home/overviewRecord.ts';
	import AboutFigures from '#lib/features/record/AboutFigures.svelte';
	import FactList from '#lib/features/record/FactList.svelte';
	import FactRow from '#lib/features/record/FactRow.svelte';
	import RecordActionGroup from '#lib/features/record/RecordActionGroup.svelte';
	import CiteBlock from '#lib/features/record/CiteBlock.svelte';
	import RecordAnswer from '#lib/features/record/RecordAnswer.svelte';
	import RecordCard from '#lib/features/record/RecordCard.svelte';
	import RecordDataTable from '#lib/features/record/RecordDataTable.svelte';
	import RecordPending from '#lib/features/record/RecordPending.svelte';
	import ScreenTitle from '#lib/features/record/ScreenTitle.svelte';
	import StateMark from '#lib/features/record/StateMark.svelte';
	import RecordChart from '#lib/features/record/charts/RecordChart.svelte';
	import { earlyLateDefinitionEn } from '#lib/features/record/methodCatalogText.ts';
	import {
		dailyPeriods,
		dailyTitles,
		onTimeStatement,
	} from '#lib/features/record/departureDailyText.ts';
	import { recordSectionLinks } from '#lib/features/record/recordLinks.ts';
	import { recordState, recordStateFor } from '#lib/features/record/recordStates.ts';
	import {
		choose,
		lastGoodNote,
		lowCoverageText,
		measuredShare,
		tally,
		timingBasis,
	} from '#lib/features/record/recordText.ts';
	import {
		agencyMessage,
		agencyMessagePeriods,
		agencyMessagePreview,
	} from '#lib/site/agencyMessages.ts';
	import {
		countedUnit,
		dailyAlertsLink,
		agencyName,
		alertsNotTrackedLine,
		alertsNotTrackedOnDates,
		dateRange,
		longDate,
		methodEvidence,
		noticeCountEvidence,
		noticeSampleEvidence,
		citationSource,
		pageCitation,
		recordStamp,
		recordPercent,
		rowSentence,
		sampleWithMinimum,
		tripOutcomeLabels,
		tripOutcomeNote,
		tripsRunSentence,
		unconfirmedTripsRange,
	} from '#lib/site/presenter.ts';
	import { tripOutcomes, unsettledTrips } from '#lib/features/record/tripOutcomes.ts';
	import { carryFrameState, frameHref, recordStart } from '#lib/site/frameState.ts';
	import { transitDisplay } from '#lib/site/transitDisplayContext.ts';
	import type { DailySection } from '#lib/server/departureDailyRecord.ts';
	import type {
		EngineResult,
		RankingAnswer,
		RecordAnswer as EngineAnswer,
		RecordMeasure,
	} from '#lib/server/engine.ts';
	import { recoverReadings } from '#lib/features/record/recordRecovery.svelte.ts';
	import type { RecordWaiting } from '#lib/features/record/recordWaiting.ts';
	import AboutFiguresWaiting from '#lib/features/home/AboutFiguresWaiting.svelte';
	import WaitingFoot from '#lib/features/home/WaitingFoot.svelte';
	import type { PageData } from './$types';
	import { dailySectionCitation } from './dailyCitation.ts';

	let { data: routeData }: { data: PageData } = $props();
	const readings = recoverReadings(
		() => routeData.report,
		({ period, city, lang }) =>
			period ? { screen: 'receipt', from: period.from, to: period.to, city, lang } : null,
	);
	const data = $derived(readings() ?? routeData.report);
	const { lang, period, city, operator, cityName } = $derived(data);
	const display = transitDisplay();
	const t = (en: string, fr: string) => choose(lang, en, fr);
	const copy = $derived(overviewCopy[lang]);
	const unavailable = $derived(t('Unavailable', 'Indisponible'));
	const connection = $derived(
		t('The record is temporarily unavailable.', 'Le bilan est temporairement indisponible.'),
	);
	const stamp = $derived(
		period ? { kind: 'record' as const, label: recordStamp(period, lang) } : undefined,
	);
	const subtitle = $derived(
		operator && operator !== cityName ? [operator, cityName].join(', ') : cityName,
	);
	const pinned = $derived.by(() => {
		const url = new SvelteURL(page.url.href);
		url.searchParams.set('provider', city);
		url.searchParams.delete('date');
		url.hash = '';
		return new URL(
			frameHref(url, { mode: 'record', period: period && { ...period, preset: null } }),
			url,
		);
	});
	function link(path: string) {
		return carryFrameState(localizeHref(path, lang, city), pinned);
	}
	const answers = $derived(new Map(data.sections.map(({ section, answer }) => [section, answer])));
	const files = $derived(
		data.sections
			.filter(({ section }) => section !== 'messages' || !data.messagesLimited)
			.map(({ section }) => ({
				href: recordSectionLinks(pinned, section).csv,
				label: dailyTitles[section][lang === 'fr' ? 1 : 0],
			})),
	);
	const lineRanking = $derived(ranked(answers.get('lines')));
	const stopRanking = $derived(ranked(answers.get('stops')));
	const rankings = $derived(Promise.all([lineRanking, stopRanking]));
	const deliveryAnswer = $derived(answers.get('delivery'));
	const punctualityAnswer = $derived(answers.get('punctuality'));
	const periodsAnswer = $derived(answers.get('periods'));
	const messagesAnswer = $derived(answers.get('messages'));
	const bandTitle = $derived(t('Early, on time and late', 'En avance, à l’heure et en retard'));
	const source = $derived(citationSource(operator ?? cityName, routeData.provider, lang));
	// Each card waits as its final shape (holistic pass D4); a busy card keeps it.
	const waiting = {
		// The answer carries the unconfirmed-trips range under its figure, as a comparison line.
		answer: { shape: 'answer', comparison: true },
		periods: { shape: 'rows', count: 5, lines: 2, lead: 'none' },
		messages: { shape: 'notice', count: 3 },
	} as const satisfies Record<string, RecordWaiting>;

	async function ranked(
		answer: Promise<EngineResult<EngineAnswer>> | undefined,
	): Promise<EngineResult<RankingAnswer>> {
		const result = await answer;
		if (!result) return { kind: 'unconfigured' };
		return result.kind === 'answer' && !('rows' in result.answer)
			? { kind: 'unreachable' }
			: (result as EngineResult<RankingAnswer>);
	}
	function measure(result: EngineResult<EngineAnswer> | undefined) {
		return result?.kind === 'answer' && 'value' in result.answer ? result.answer : undefined;
	}
	function tripsRun(answer: RecordMeasure | undefined) {
		const counts = answer?.evidence.counts;
		return answer?.state === 'measured' && counts?.eligible && counts.ran != null
			? (answer.value.trips_run ?? null)
			: null;
	}
	function readingState(answer: RecordMeasure | undefined) {
		return answer?.state === 'not_tracked' ? 'not_measured' : recordStateFor(answer?.state);
	}
	function readingText(result: EngineResult<EngineAnswer> | undefined) {
		const answer = measure(result);
		if (answer) return recordState(readingState(answer))[lang];
		// The waiting words of a busy card, as a part of the answer's sentence (D6).
		return result?.kind === 'busy' ? t('Waiting for a turn', 'En attente') : unavailable;
	}
	function evidenceSample(answer: EngineAnswer, section: DailySection) {
		const days = countedUnit(answer.evidence.days_included.length, 'day', lang);
		if ('value' in answer) {
			const counts = answer.evidence.counts;
			if (section === 'messages') {
				const notices =
					answer.state === 'measured' && !data.messagesLimited ? recordNoticeCards(answer) : null;
				if (!notices?.length || counts.alerts == null) return null;
				// The report keeps a few notices; the foot says how many of all of them it shows.
				const total = answer.evidence.notice_total;
				return total == null
					? noticeCountEvidence(
							notices.length,
							counts.alerts,
							agencyName(operator ?? cityName, routeData.provider),
							lang,
						)
					: noticeSampleEvidence(notices.length, total, lang);
			}
			return recordCounts(
				counts.classified,
				section === 'delivery' ? counts.ran : null,
				days,
				lang,
			);
		}
		if (!('cells' in answer)) return null;
		const events = answer.cells.reduce(
			(total, cell) => total + (cell.evidence.counts.classified ?? 0),
			0,
		);
		return events ? recordCounts(events, null, days, lang) : null;
	}
	function rankingEvidence(lines: EngineResult<RankingAnswer>, stops: EngineResult<RankingAnswer>) {
		const inputs = [
			[lines, t('Lines', 'Lignes')],
			[stops, t('Stops', 'Arrêts')],
		] as const;
		const separator = t(': ', ' : ');
		const readings = inputs.flatMap(([result, label]) => {
			if (result.kind !== 'answer') return [];
			const { answer, lastGood } = result;
			return [
				{
					label,
					// The footer counts the rows the preview shows.
					events: previewRows(answer.rows).reduce((total, row) => total + row.sample, 0),
					dates: answer.evidence.days_included,
					version: methodEvidence(answer.evidence, lang, true),
					lastGood,
				},
			];
		});
		const counted = readings.filter(({ events }) => events > 0);
		const commonDates = counted[0]?.dates ?? [];
		const sharedDays =
			commonDates.length && counted.every(({ dates }) => dates.join() === commonDates.join())
				? countedUnit(commonDates.length, 'day', lang)
				: '';
		const samples = counted
			.map(({ label, events, dates }) => {
				const days =
					!sharedDays && dates.length ? ', ' + countedUnit(dates.length, 'day', lang) : '';
				return label + separator + countedUnit(events, 'event', lang) + days;
			})
			.join(' · ');
		const versions = new Set(readings.map(({ version }) => version));
		return {
			sample: samples + (sharedDays ? ', ' + sharedDays : ''),
			versions:
				versions.size <= 1
					? readings[0]?.version
					: readings.map(({ label, version }) => label + separator + version).join(' · '),
			stale: readings
				.filter(({ lastGood }) => lastGood)
				.map(({ label }) => label + separator + lastGoodNote[lang])
				.join(' · '),
		};
	}
	function citationText(
		section: DailySection,
		result: Extract<EngineResult<EngineAnswer>, { kind: 'answer' }>,
	) {
		const { answer, lastGood } = result;
		// As every page citation: the source and licence of the data and the day it was read.
		return dailySectionCitation(
			{
				subject: t('Daily report', 'Rapport quotidien') + ', ' + cityName,
				section: dailyTitles[section][lang === 'fr' ? 1 : 0],
				period: { from: answer.evidence.start_date, to: answer.evidence.end_date },
				statement:
					section === 'punctuality' && 'value' in answer
						? onTimeStatement(answer, lang)
						: undefined,
				method: methodEvidence(answer.evidence, lang),
				note: lastGood ? lastGoodNote[lang] : undefined,
				source,
				href: recordSectionLinks(pinned, section).share,
			},
			lang,
		);
	}
	type PeriodRow = Omit<ReturnType<typeof dailyPeriods>[number], 'detail'> & {
		id: string;
		stateDetail: string | null;
	};
	const columns: DataTableColumn<PeriodRow>[] = $derived([
		{ key: 'hours', header: t('Hours', 'Heures'), cell: hours },
		{ key: 'late', header: t('Late share', 'Part en retard'), numeric: true, cell: late },
		{ key: 'events', header: t('Stop events', 'Passages aux arrêts'), numeric: true, cell: events },
	]);
	const deliveryLabels = $derived(tripOutcomeLabels(lang));
	// The order reads as a sum: the five rows under Scheduled add up to it.
	const deliveryRows = [
		'scheduled',
		'noLiveData',
		'statusUnknown',
		'ran',
		'cancelled',
		'missing',
	] as const;
</script>

{#snippet hours(row: PeriodRow)}<span class="font-mono">{row.hours}</span>{/snippet}
{#snippet phoneLate(row: PeriodRow)}
	{#if row.value != null}{row.value}{:else if row.state}<StateMark
			state={row.state}
			locale={lang}
		/>{/if}
{/snippet}
{#snippet late(row: PeriodRow)}
	{#if row.value != null}<strong>{row.value}</strong>
	{:else if row.state}
		<StateMark state={row.state} locale={lang} />
		{#if row.stateDetail}<span class="block text-muted-foreground">{row.stateDetail}</span>{/if}
	{/if}
{/snippet}
{#snippet events(row: PeriodRow)}
	{#if row.count != null}{row.count}
	{:else if row.state}{recordState(row.state)[lang]}{/if}
{/snippet}

{#snippet citation()}
	<CiteBlock
		locale={lang}
		text={pageCitation(
			t('Daily report', 'Rapport quotidien') + ', ' + cityName,
			period,
			pinned.href,
			lang,
			citationSource(operator ?? cityName, routeData.provider, lang),
		)}
	/>
{/snippet}
{#snippet figures()}
	{#each data.sections as { section, answer } (section)}
		{#await answer then result}
			{#if result.kind === 'answer'}<CiteBlock
					locale={lang}
					text={citationText(section, result)}
				/>{/if}
		{/await}
	{/each}
{/snippet}
{#snippet actions()}
	<div class="print:hidden">
		<RecordActionGroup
			locale={lang}
			href={pinned.href}
			{files}
			{citation}
			{figures}
			print={() => window.print()}
			printNote={t(
				'A one-day report prints on one sheet.',
				'Le rapport d’une journée tient sur une feuille.',
			)}
		/>
	</div>
{/snippet}
{#snippet failure(result: EngineResult<EngineAnswer> | undefined, shape?: RecordWaiting)}
	{#if result?.kind === 'busy'}<RecordPending locale={lang} busy {shape} />
	{:else}<p>{connection}</p>{/if}
{/snippet}
{#snippet missingMeasure(answer: RecordMeasure, trip = false)}
	<StateMark state={readingState(answer)} locale={lang} />
	{#if answer.state === 'too_few_to_judge' && answer.info?.[0]?.minimum_sample != null}
		{@const count = answer.evidence.counts[trip ? 'eligible' : 'classified']}
		{#if count != null}<p>
				{sampleWithMinimum(
					countedUnit(count, trip ? 'trip' : 'event', lang),
					answer.info[0].minimum_sample,
					lang,
				)}
			</p>{/if}
	{/if}
{/snippet}
{#snippet footerEvidence(result: EngineResult<EngineAnswer>, section: DailySection)}
	{#if result.kind === 'answer'}
		<RecordEvidenceLine
			locale={lang}
			evidence={result.answer.evidence}
			sample={evidenceSample(result.answer, section)}
			note={result.lastGood ? lastGoodNote[lang] : undefined}
		/>
	{/if}
{/snippet}
{#snippet messagesNotTracked(onDates = false)}
	<p class="flex min-w-0 items-baseline gap-2">
		<StateMark state="alerts_not_tracked" locale={lang} hiddenLabel />
		<span
			>{onDates
				? alertsNotTrackedOnDates(agencyName(operator ?? cityName, routeData.provider), lang)
				: alertsNotTrackedLine(agencyName(operator ?? cityName, routeData.provider), lang)}</span
		>
	</p>
{/snippet}
{#snippet lead(
	current: EngineResult<EngineAnswer>,
	delivery: EngineResult<EngineAnswer> | undefined,
)}
	{@const punctuality = measure(current)}
	{@const service = measure(delivery)}
	{@const value = measuredShare(punctuality, 'on_time')}
	{@const trips = tripsRun(service)}
	{@const unsettled = service && trips != null ? unsettledTrips(service.evidence) : null}
	{@const bounds =
		service && unsettled != null
			? unconfirmedTripsRange(
					service.evidence.counts.ran ?? -1,
					service.evidence.counts.eligible ?? -1,
					unsettled,
					lang,
				)
			: null}
	{@const punctualityText =
		value == null
			? t('On-time share', 'Part des passages à l’heure') + ' · ' + readingText(current)
			: t('of observed stop events were on time', 'des passages observés étaient à l’heure')}
	{@const deliveryText =
		trips == null
			? t('Share of trips that ran', 'Part des trajets effectués') + ' · ' + readingText(delivery)
			: recordPercent(trips, lang) +
				' ' +
				tripsRunSentence(service?.evidence.counts.eligible, lang)}
	{@const sentence =
		value != null && trips != null
			? [punctualityText, t(', and ', ', et '), deliveryText, '.'].join('')
			: [punctualityText + '.', delivery ? deliveryText + '.' : ''].filter(Boolean).join(' ')}
	<div
		class="grid min-w-0 gap-2 xl:grid-cols-[minmax(0,1fr)_fit-content(48%)] xl:gap-6 print:block"
	>
		<RecordAnswer
			locale={lang}
			value={value == null ? null : recordPercent(value, lang)}
			{sentence}
			state={value == null && punctuality ? readingState(punctuality) : undefined}
			time={stamp}
		>
			{#snippet meta()}
				{@const currentSample = punctuality?.evidence.counts.classified}
				{@const ran = service?.evidence.counts.ran}
				{@const days = punctuality?.evidence.days_included.length}
				{@const sample = recordCounts(
					currentSample,
					ran,
					days ? countedUnit(days, 'day', lang) : '',
					lang,
				)}
				{#if bounds}<p>{bounds}</p>{/if}
				{#if sample}<p>{t('Counted:', 'Ce qui est compté :')} {sample}</p>{/if}
				{#if current.kind !== 'answer'}{@render failure(current)}{/if}
				{#if current.kind === 'answer' && current.lastGood}<p>{lastGoodNote[lang]}</p>{/if}
				{#if punctuality?.state === 'too_few_to_judge' && punctuality.info?.[0]?.minimum_sample != null && currentSample != null}
					<p>
						{sampleWithMinimum(
							countedUnit(currentSample, 'event', lang),
							punctuality.info[0].minimum_sample,
							lang,
						)}
					</p>
				{/if}
				{#if service?.state === 'too_few_to_judge' && service.info?.[0]?.minimum_sample != null && service.evidence.counts.eligible != null}
					<p>
						{sampleWithMinimum(
							countedUnit(service.evidence.counts.eligible, 'trip', lang),
							service.info[0].minimum_sample,
							lang,
						)}
					</p>
				{/if}
			{/snippet}
		</RecordAnswer>
		{@render actions()}
	</div>
{/snippet}

{#snippet about(current: RecordMeasure | undefined, waiting = false)}
	{@const counts = current?.evidence.counts}
	{@const days = current?.evidence.days_included.length}
	{@const observed = current?.evidence.share_observed}
	{@const fields = [
		{ key: 'period', label: copy.period, text: period ? dateRange(period, lang) : null },
		{
			key: 'counted',
			label: copy.counted,
			waiting,
			text: recordCounts(
				counts?.classified,
				null,
				days ? countedUnit(days, 'day', lang) : '',
				lang,
			),
		},
		{
			key: 'observed',
			label: copy.observed,
			waiting: waiting && 6,
			text: [
				observed == null
					? null
					: copy.observedShare(
							recordPercent(observed, lang),
							counts?.scheduled == null ? undefined : tally(counts.scheduled, lang),
						),
				current?.evidence.low_coverage ? lowCoverageText(lang) + '.' : null,
				timingBasis(counts, lang),
				current?.coverage_note?.[lang],
			]
				.filter(Boolean)
				.join(' '),
		},
		{ key: 'means', label: copy.means, text: copy.definition },
		{
			key: 'method',
			label: copy.methodRow,
			text: null,
			link: { href: link('/metrics'), label: copy.method },
		},
		{
			key: 'source',
			label: copy.source,
			text: [
				copy.feeds(agencyName(operator ?? cityName, routeData.provider)),
				copy.recordStart(longDate(recordStart(page.data.provider), lang)),
			].join(' '),
		},
		{
			key: 'error',
			label: copy.errorRow,
			text: null,
			link: { href: `${link('/metrics')}#about-transit`, label: copy.errorLink },
		},
	]}
	<div>
		{#if waiting}<AboutFiguresWaiting title={copy.about} {fields} />
		{:else}<AboutFigures compactPrint title={copy.about} {fields} />{/if}
	</div>
{/snippet}

<Surface class="print:py-0!">
	<article class="daily-report min-w-0">
		<RecordScreen>
			{#if !period}
				<RecordGroup><ScreenTitle title={data.title} {subtitle} /></RecordGroup>
				<p role="status">
					{t(
						'This date is outside the available record.',
						'Cette date est hors du bilan disponible.',
					)}
				</p>
			{:else if data.sections.length}
				<div class="report-content min-w-0 print:grid print:grid-cols-2 print:gap-3">
					<!-- The title, the answer and the cards share one section: no page divider stands
					     between the title and the answer. -->
					<RecordGroup class="print:contents">
						<div class="report-title"><ScreenTitle title={data.title} {subtitle} /></div>
						<div class="report-sections" data-slot="screen-content">
							<section
								id="punctuality"
								aria-label={t(...dailyTitles.punctuality)}
								data-slot="screen-answer"
								class="grid min-w-0 gap-3"
							>
								{#await answers.get('punctuality')}
									{@const pending = answers.get('punctuality')}
									{#key pending}<RecordPending
											shape={waiting.answer}
											locale={lang}
											answer={pending}
										/>{/key}
								{:then current}
									{#if current?.kind === 'busy'}
										<RecordPending shape={waiting.answer} locale={lang} busy />
									{:else if current}
										{#await answers.get('delivery')}
											{@render lead(current, undefined)}
										{:then delivery}
											{@render lead(current, delivery)}
										{/await}
									{/if}
								{/await}
							</section>

							<div class="report-pair">
								<div id="delivery" class="grid min-w-0">
									<RecordCard compactPrint title={t(...dailyTitles.delivery)} {stamp} stampRule>
										{#await deliveryAnswer}
											{#key deliveryAnswer}<RecordPending
													shape="trip-facts"
													locale={lang}
													answer={deliveryAnswer}
												/>{/key}
										{:then result}
											{@const service = measure(result)}
											{#if !service}{@render failure(result, 'trip-facts')}
											{:else if service.state !== 'measured'}{@render missingMeasure(service, true)}
											{:else}
												{@const outcomes = tripOutcomes(service.evidence)}
												{#if outcomes}
													<FactList
														leading={false}
														class="print:[&_[data-slot=fact-row]]:min-h-0 print:[&_[data-slot=fact-row]]:py-0.5"
													>
														{#each deliveryRows as key (key)}
															{@const share = key === 'ran' ? tripsRun(service) : null}
															<FactRow
																label={deliveryLabels[key]}
																detail={share == null
																	? undefined
																	: recordPercent(share, lang) +
																		' ' +
																		tripsRunSentence(outcomes.known, lang)}
															>
																<strong>{tally(outcomes[key], lang)}</strong>
															</FactRow>
														{/each}
													</FactList>
												{:else}<StateMark state="unknown" locale={lang} />{/if}
											{/if}
										{/await}
										<!-- The definitions need no data: they stand while the counts stream in. -->
										<p class="mt-3 text-muted-foreground">{tripOutcomeNote(lang)}</p>
										<p class="mt-3 text-muted-foreground">
											{t(
												'A cancelled trip comes with a notice from the agency. A missing trip has no vehicle reporting and no notice.',
												'Un trajet annulé fait l’objet d’un avis de la société de transport. Pour un trajet manquant, aucun véhicule ne transmet de données et aucun avis n’a été publié.',
											)}
										</p>
										{#snippet evidence()}
											{#await deliveryAnswer}<WaitingFoot
												/>{:then result}{#if result}{@render footerEvidence(
														result,
														'delivery',
													)}{/if}{/await}
										{/snippet}
									</RecordCard>
								</div>
								<div class="grid min-w-0">
									<RecordCard compactPrint title={bandTitle} {stamp} stampRule>
										{#await punctualityAnswer}
											{#key punctualityAnswer}<RecordPending
													shape="bands"
													locale={lang}
													answer={punctualityAnswer}
												/>{/key}
										{:then result}
											{@const punctuality = measure(result)}
											{#if !punctuality}{@render failure(result, 'bands')}
											{:else if punctuality.state !== 'measured'}{@render missingMeasure(
													punctuality,
												)}
											{:else}
												{#if ['early', 'on_time', 'late'].every((band) => measuredShare(punctuality, band) != null)}
													<RecordChart
														title={bandTitle}
														id="punctuality-bands"
														locale={lang}
														input={{ kind: 'bands', answer: punctuality }}
													/>
													<p class="mt-3 text-muted-foreground">
														{t(
															earlyLateDefinitionEn,
															'En avance\u00a0: plus d’une minute avant l’horaire. En retard\u00a0: plus de 5 minutes après l’horaire.',
														)}
													</p>
												{:else}<StateMark state="unknown" locale={lang} />{/if}
											{/if}
										{/await}
										{#snippet evidence()}
											{#await punctualityAnswer}<WaitingFoot
												/>{:then result}{#if result}{@render footerEvidence(
														result,
														'punctuality',
													)}{/if}{/await}
										{/snippet}
									</RecordCard>
								</div>
							</div>

							<div id="periods">
								<RecordCard
									compactPrint
									title={t('The day in five parts', 'La journée en cinq périodes')}
									{stamp}
									stampRule
								>
									{#await periodsAnswer}
										{#key periodsAnswer}<RecordPending
												locale={lang}
												answer={periodsAnswer}
												shape={waiting.periods}
											/>{/key}
									{:then result}
										{#if result?.kind === 'answer' && 'cells' in result.answer}
											<RecordDataTable
												locale={lang}
												title={t(
													'Late share by part of the day',
													'Part en retard selon la période de la journée',
												)}
												rowHeader={t('Part of the day', 'Période de la journée')}
												{columns}
												rows={dailyPeriods(result.answer, lang).map(({ detail, ...row }) => ({
													...row,
													id: String(row.start),
													stateDetail: detail,
												}))}
												scrollMinWidth="26rem"
												phone={{
													value: phoneLate,
													line: (row) =>
														rowSentence(
															[
																row.hours,
																row.stateDetail ??
																	(row.classified > 0 &&
																		countedUnit(row.classified, 'event', lang)),
															],
															lang,
														),
												}}
											/>
										{:else}
											{@render failure(result, waiting.periods)}
											{#if result?.kind !== 'busy'}
												<ul>
													{#each dailyPeriods(null, lang) as row (row.start)}<li>
															{row.label} · {unavailable}
														</li>{/each}
												</ul>
											{/if}
										{/if}
									{/await}
									{#snippet evidence()}
										{#await periodsAnswer}<WaitingFoot
											/>{:then result}{#if result}{@render footerEvidence(
													result,
													'periods',
												)}{/if}{/await}
									{/snippet}
								</RecordCard>
							</div>

							<div id="messages">
								<RecordCard
									interactive
									compactPrint
									title={t(...dailyTitles.messages)}
									{stamp}
									stampRule
								>
									{#if !data.tracked}
										{@render messagesNotTracked()}
									{:else}
										{#await messagesAnswer}
											{#key messagesAnswer}<RecordPending
													locale={lang}
													answer={messagesAnswer}
													shape={waiting.messages}
												/>{/key}
										{:then result}
											{@const messages = measure(result)}
											{@const count = messages?.evidence.counts.alerts}
											{@const notices =
												messages?.state === 'measured' && !data.messagesLimited
													? recordNoticeCards(messages)
													: null}
											{#if !messages}{@render failure(result, waiting.messages)}
											{:else if messages.state === 'not_tracked'}
												{@render messagesNotTracked(true)}
											{:else if messages.state !== 'measured'}{@render missingMeasure(messages)}
											{:else if count === 0}
												<p>
													{t(
														'No notices in the tracked record for these dates.',
														'Aucun avis enregistré dans le bilan à ces dates.',
													)}
												</p>
											{:else if data.messagesLimited}<p>{alertDetailsLimit[lang]}</p>
											{:else if notices?.length}
												<ul class="message-rows">
													{#each notices as message (message.key)}
														{@const { title, body } = agencyMessage(message, lang, message.stops)}
														{@const dates = agencyMessagePeriods(
															message.periods,
															lang,
															data.timeZone,
															false,
														)}
														<li class="message-row grid min-w-0 gap-x-4 py-2 print:py-0.5">
															<div class="flex flex-wrap items-start gap-x-2">
																{#each message.routes as id (id)}
																	{@const line = display.lineName(id)}
																	<a
																		class="inline-flex min-h-11 min-w-11 items-center"
																		href={link('/lines/' + encodeURIComponent(id))}
																		aria-label={line.spoken}
																		><RoutePlate code={line.number ?? id} /></a
																	>
																{/each}
															</div>
															<div class="min-w-0">
																<h3 class="font-semibold" lang={title.lang}>
																	{title.text}
																</h3>
																{#if message.stops.length > 1}
																	<p class="text-muted-foreground">
																		{t('Stops:', 'Arrêts\u00a0:')}
																		{message.stops.join(' · ')}
																	</p>
																{/if}
																{#if dates.length}<p
																		class="text-muted-foreground"
																		data-slot="agency-message-dates"
																	>
																		{dates.join(' · ')}
																	</p>
																{/if}
																{#if body}<p
																		class="text-muted-foreground print:hidden"
																		lang={body.lang}
																	>
																		{agencyMessagePreview(body)}
																	</p>
																{/if}
															</div>
														</li>
													{/each}
												</ul>
											{:else}<p>
													{t('Message text is unavailable.', 'Le texte des avis est indisponible.')}
												</p>
											{/if}
											{#if messages?.state === 'measured' && count != null && count > 0}
												<a
													class="inline-flex min-h-11 items-center text-primary underline"
													href={link('/alerts')}
												>
													{dailyAlertsLink(
														messages.evidence.notice_total ?? notices?.length ?? count,
														lang,
														notices == null,
													)}
												</a>
											{/if}
										{/await}
									{/if}
									{#snippet evidence()}
										{#await messagesAnswer}<WaitingFoot
											/>{:then result}{#if result}{@render footerEvidence(
													result,
													'messages',
												)}{/if}{/await}
									{/snippet}
								</RecordCard>
							</div>

							<div id="lines">
								<RecordCard
									interactive
									compactPrint
									title={t('Lines and stops to inspect', 'Lignes et arrêts à examiner')}
									{stamp}
									stampRule
								>
									{#await rankings then results}
										{#if results.some(({ kind }) => kind !== 'answer' && kind !== 'busy')}<p>
												{connection}
											</p>{/if}
									{/await}
									<DashboardGrid gutter={false} minTile="18rem">
										<RecordRanking
											locale={lang}
											kind="line"
											ranking={lineRanking}
											{link}
											heading={t(
												'Lines with the lowest on-time share',
												'Lignes où la part des passages à l’heure est la plus faible',
											)}
										/>
										<div id="stops">
											<RecordRanking
												locale={lang}
												kind="stop"
												outlineStopCode
												ranking={stopRanking}
												directory={data.directory}
												{link}
												heading={t(
													'Stops with the lowest on-time share',
													'Arrêts où la part des passages à l’heure est la plus faible',
												)}
											/>
										</div>
									</DashboardGrid>
									{#snippet evidence()}
										{#await rankings}<WaitingFoot />{:then [lines, stops]}
											{@const evidence = rankingEvidence(lines, stops)}
											{#if evidence.versions}
												<RecordEvidenceLine
													locale={lang}
													sample={evidence.sample}
													versions={evidence.versions}
													note={evidence.stale}
												/>
											{/if}
										{/await}
									{/snippet}
								</RecordCard>
							</div>
						</div>
					</RecordGroup>
					<RecordGroup class="print:contents">
						<!-- On the page from the first frame; the two sentences that need the answer pulse. -->
						{#await answers.get('punctuality')}
							{@render about(undefined, true)}
						{:then result}
							{@render about(measure(result))}
						{/await}
						<div class="hidden print:block report-citation">
							{#await answers.get('punctuality') then result}
								{#if result?.kind === 'answer'}<p>{citationText('punctuality', result)}</p>{/if}
							{/await}
						</div>
					</RecordGroup>
				</div>
			{/if}
		</RecordScreen>
	</article>
</Surface>

<style>
	/* A short card keeps its own height instead of a band of nothing under its rows (F1.1). */
	.report-pair {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(min(100%, 25rem), 1fr));
		align-items: start;
		gap: var(--space-card-gap);
	}
	.report-sections {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: var(--space-card-gap);
		min-inline-size: 0;
	}
	.message-row {
		grid-template-columns: fit-content(30%) minmax(0, 1fr);
	}
	.message-rows {
		container-type: inline-size;
	}
	@container (max-width: 13rem) {
		.message-row {
			grid-template-columns: minmax(0, 1fr);
		}
	}
	@page {
		margin: 8mm;
	}
	@media print {
		:global(
			body:has(.daily-report)
				:is(
					[data-slot='app-frame-chrome'],
					[data-slot='surface-rail'],
					[data-slot='surface-rail-mobile'],
					[data-slot='record-patience'],
					[data-slot='page-section-boundary'],
					[data-slot='footer']
				)
		) {
			display: none !important;
		}
		:global(
			body:has(.daily-report)
				:is([data-slot='app-shell'], [data-slot='app-frame'], .app-frame-body, #main-flow, #main)
		) {
			display: block;
			min-height: 0;
			overflow: visible;
		}
		.daily-report {
			print-color-adjust: exact;
			zoom: 0.52;
			gap: 0.5rem;
			padding: 0;
			color-scheme: light;
			--background: Canvas;
			--card: Canvas;
			--foreground: CanvasText;
			--muted-foreground: CanvasText;
			--accent-text: CanvasText;
			--border: GrayText;
			--shadow-card: none;
			color: CanvasText;
			--primary: CanvasText;
			--secondary-foreground: CanvasText;
		}
		/* The sections join the report's two print columns. */
		.report-sections {
			display: contents;
		}
		.report-content :is(.report-title, #punctuality, .report-pair, .report-citation) {
			grid-column: 1 / -1;
		}
		.report-pair {
			gap: 0.75rem;
		}
		.report-citation {
			overflow-wrap: anywhere;
			font-size: var(--text-small);
		}
	}
</style>
