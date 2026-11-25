<script lang="ts">
	import { page } from '$app/state';
	import { SvelteURL } from 'svelte/reactivity';
	import { RoutePlate } from '@yesid/ui/brand';
	import { DashboardGrid, Surface } from '@yesid/ui/layout';
	import { DataTable, type DataTableColumn } from '@yesid/ui/table';
	import { localizeHref } from '#lib/i18n/index.ts';
	import { alertDetailsLimit } from '#lib/features/alerts/alertRecord.ts';
	import RecordRanking from '#lib/features/home/RecordRanking.svelte';
	import { overviewCopy } from '#lib/features/home/overviewRecord.copy.ts';
	import { recordCounts } from '#lib/features/home/overviewRecord.ts';
	import AboutFigures from '#lib/features/record/AboutFigures.svelte';
	import RecordActionGroup from '#lib/features/record/RecordActionGroup.svelte';
	import RecordAnswer from '#lib/features/record/RecordAnswer.svelte';
	import RecordCard from '#lib/features/record/RecordCard.svelte';
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
		agencyMessageDates,
		agencyMessageHeading,
		countedUnit,
		dateRange,
		longDate,
		methodEvidence,
		recordStamp,
		reportPercent,
		sampleWithMinimum,
	} from '#lib/site/presenter.ts';
	import { carryFrameState, frameHref, RECORD_START } from '#lib/site/frameState.ts';
	import { transitDisplay } from '#lib/site/transitDisplayContext.ts';
	import type { DailySection } from '#lib/server/departureDailyRecord.ts';
	import type {
		EngineResult,
		RankingAnswer,
		RecordAnswer as EngineAnswer,
		RecordMeasure,
	} from '#lib/server/engine.ts';
	import type { PageData } from './$types';

	let { data: routeData }: { data: PageData } = $props();
	const data = $derived(routeData.report);
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
	const formatShare = (value: number) => reportPercent(value, lang);
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
		return result?.kind === 'busy'
			? t('Waiting for a reading.', 'Lecture en attente.')
			: unavailable;
	}
	function evidenceSample(answer: EngineAnswer, section: DailySection) {
		const days = countedUnit(answer.evidence.days_included.length, 'day', lang);
		if ('value' in answer) {
			const counts = answer.evidence.counts;
			if (section === 'messages' && answer.state === 'measured' && counts.alerts != null)
				return t(
					tally(counts.alerts, lang) + ' distinct alerts',
					tally(counts.alerts, lang) + ' avis distincts',
				);
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
					events: answer.rows.reduce((total, row) => total + row.sample, 0),
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
		const subject = t('Daily report', 'Rapport quotidien') + ', ' + cityName;
		const range = dateRange(
			{ from: answer.evidence.start_date, to: answer.evidence.end_date },
			lang,
		);
		return [
			[
				'Transit ·',
				subject + '.',
				dailyTitles[section][lang === 'fr' ? 1 : 0] + '.',
				range + '.',
			].join(' '),
			section === 'punctuality' && 'value' in answer ? onTimeStatement(answer, lang) : '',
			methodEvidence(answer.evidence, lang),
			lastGood ? lastGoodNote[lang] : '',
			recordSectionLinks(pinned, section).share,
		]
			.filter(Boolean)
			.join(' ');
	}
	type PeriodRow = ReturnType<typeof dailyPeriods>[number];
	const columns: DataTableColumn<PeriodRow>[] = $derived([
		{
			key: 'part',
			header: t('Part of the day', 'Partie de la journée'),
			rowHeader: true,
			cell: part,
		},
		{ key: 'hours', header: t('Hours', 'Heures'), cell: hours },
		{ key: 'late', header: t('Late share', 'Part en retard'), numeric: true, cell: late },
		{ key: 'events', header: t('Stop events', 'Passages aux arrêts'), numeric: true, cell: events },
	]);
	const deliveryLabels = $derived({
		scheduled: t('Scheduled trips', 'Trajets prévus'),
		ran: t('Ran', 'Effectués'),
		eligible: t('Known status', 'État connu'),
		cancelled: t('Cancelled, announced by the agency', 'Annulés, avec avis de l’agence'),
		missing: t('Missing, no vehicle and no notice', 'Manquants, sans véhicule ni avis'),
	});
</script>

{#snippet part(row: PeriodRow)}{row.label}{/snippet}
{#snippet hours(row: PeriodRow)}<span class="font-mono">{row.hours}</span>{/snippet}
{#snippet late(row: PeriodRow)}
	{#if row.value != null}{row.value}
	{:else if row.state}
		<StateMark state={row.state} locale={lang} />
		{#if row.detail}<span class="block text-muted-foreground">{row.detail}</span>{/if}
	{/if}
{/snippet}
{#snippet events(row: PeriodRow)}
	{#if row.count != null}{row.count}
	{:else if row.state}{recordState(row.state)[lang]}{/if}
{/snippet}

{#snippet citation()}
	{#each data.sections as { section, answer } (section)}
		{#await answer then result}
			{#if result.kind === 'answer'}<p>{citationText(section, result)}</p>{/if}
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
			print={() => window.print()}
		/>
	</div>
{/snippet}
{#snippet failure(result: EngineResult<EngineAnswer> | undefined)}
	{#if result?.kind === 'busy'}<RecordPending locale={lang} busy />
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
		<p
			class="flex w-full flex-wrap justify-between gap-x-3 border-t border-border pt-2 font-mono text-sm text-muted-foreground"
		>
			{#if evidenceSample(result.answer, section)}<span
					>{evidenceSample(result.answer, section)}</span
				>{/if}
			<span>{methodEvidence(result.answer.evidence, lang, true)}</span>
			{#if result.lastGood}<span>{lastGoodNote[lang]}</span>{/if}
		</p>
	{/if}
{/snippet}
{#snippet messagesNotTracked()}
	<p class="flex min-w-0 items-baseline gap-2">
		<StateMark state="not_tracked" locale={lang} hiddenLabel />
		<span
			>{t(
				'Agency messages are not tracked in this city.',
				'Les avis de l’agence ne sont pas suivis dans cette ville.',
			)}</span
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
	{@const punctualityText =
		value == null
			? t('On-time share', 'Part des passages à l’heure') + ' · ' + readingText(current)
			: t('of observed stop events were on time', 'des passages observés étaient à l’heure')}
	{@const deliveryText =
		trips == null
			? t('Share of trips that ran', 'Part des trajets effectués') + ' · ' + readingText(delivery)
			: reportPercent(trips, lang) +
				' ' +
				t(
					'of scheduled trips with a known status ran',
					'des trajets prévus dont l’état est connu ont été effectués',
				)}
	{@const sentence =
		value != null && trips != null
			? [punctualityText, t(', and ', ', et '), deliveryText, '.'].join('')
			: [punctualityText + '.', delivery ? deliveryText + '.' : ''].filter(Boolean).join(' ')}
	<RecordAnswer
		locale={lang}
		value={value == null ? null : reportPercent(value, lang)}
		{sentence}
		state={value == null && punctuality ? readingState(punctuality) : undefined}
		time={stamp}
		{actions}
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
			{#if sample}<p>{t('Counted:', 'Ce qui est compté :')} {sample}</p>{/if}
			{#if punctuality}<p class="font-mono text-sm text-muted-foreground">
					{methodEvidence(punctuality.evidence, lang, true)}
				</p>{/if}
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
{/snippet}

<Surface>
	<article class="daily-report grid min-w-0 gap-6">
		<ScreenTitle title={data.title} {subtitle} />
		{#if !period}
			<p role="status">
				{t(
					'This date is outside the available record.',
					'Cette date est hors du bilan disponible.',
				)}
			</p>
		{:else if !data.unpublished && data.sections.length}
			<div class="report-content grid min-w-0 gap-6" data-slot="screen-content">
				<section
					id="punctuality"
					aria-label={t(...dailyTitles.punctuality)}
					data-slot="screen-answer"
					class="grid min-w-0 gap-3 border-t border-border pt-4"
				>
					{#await answers.get('punctuality')}
						{@const pending = answers.get('punctuality')}
						{#key pending}<RecordPending locale={lang} answer={pending} />{/key}
					{:then current}
						{#if current}
							{#await answers.get('delivery')}
								{@render lead(current, undefined)}
							{:then delivery}
								{@render lead(current, delivery)}
							{/await}
						{/if}
					{/await}
					<p class="print:hidden">
						{t(
							'One summary that can be cited, for any day or any dates. A report for one day also prints on one sheet.',
							'Un résumé à citer pour une journée ou une période de votre choix. Le rapport d’une journée s’imprime aussi sur une seule feuille.',
						)}
					</p>
				</section>

				<div class="report-pair">
					<div id="delivery" class="grid min-w-0">
						<RecordCard compactPrint title={t(...dailyTitles.delivery)} {stamp}>
							{#await deliveryAnswer}
								{#key deliveryAnswer}<RecordPending locale={lang} answer={deliveryAnswer} />{/key}
							{:then result}
								{@const service = measure(result)}
								{#if !service}{@render failure(result)}
								{:else if service.state !== 'measured'}{@render missingMeasure(service, true)}
								{:else}
									<dl class="delivery-rows grid">
										{#each Object.entries(deliveryLabels) as [key, label] (key)}
											{@const count = service.evidence.counts[key]}
											{@const share = key === 'ran' ? tripsRun(service) : null}
											<div
												class="delivery-row grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 border-b border-border py-2 print:py-0.5"
											>
												<dt>{label}</dt>
												<dd class="text-right font-semibold tabular-nums">
													{#if count != null}{tally(count, lang)}{:else}<StateMark
															state="unknown"
															locale={lang}
														/>{/if}
													{#if share != null}<span class="block text-muted-foreground"
															>{reportPercent(share, lang)}</span
														>{/if}
												</dd>
											</div>
										{/each}
									</dl>
									<p class="mt-3 text-muted-foreground">
										{t(
											'A cancelled trip comes with a notice from the agency. A missing trip has no vehicle reporting and no notice.',
											'Un trajet annulé fait l’objet d’un avis de l’agence. Pour un trajet manquant, aucun véhicule ne transmet de données et aucun avis n’a été publié.',
										)}
									</p>
								{/if}
							{/await}
							{#snippet footer()}{#await deliveryAnswer then result}{#if result}{@render footerEvidence(
											result,
											'delivery',
										)}{/if}{/await}{/snippet}
						</RecordCard>
					</div>
					<div class="grid min-w-0">
						<RecordCard compactPrint title={bandTitle} {stamp}>
							{#await punctualityAnswer}
								{#key punctualityAnswer}<RecordPending
										locale={lang}
										answer={punctualityAnswer}
									/>{/key}
							{:then result}
								{@const punctuality = measure(result)}
								{#if !punctuality}{@render failure(result)}
								{:else if punctuality.state !== 'measured'}{@render missingMeasure(punctuality)}
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
												'En avance : plus de 1 minute avant l’horaire. En retard : plus de 5 minutes après l’horaire.',
											)}
										</p>
									{:else}<StateMark state="unknown" locale={lang} />{/if}
								{/if}
							{/await}
							{#snippet footer()}{#await punctualityAnswer then result}{#if result}{@render footerEvidence(
											result,
											'punctuality',
										)}{/if}{/await}{/snippet}
						</RecordCard>
					</div>
				</div>

				<div id="periods">
					<RecordCard
						compactPrint
						title={t('The day in five parts', 'La journée en cinq périodes')}
						{stamp}
					>
						{#await periodsAnswer}
							{#key periodsAnswer}<RecordPending locale={lang} answer={periodsAnswer} />{/key}
						{:then result}
							{#if result?.kind === 'answer' && 'cells' in result.answer}
								<DataTable
									caption={t(
										'Late share by part of the day',
										'Part en retard selon la période de la journée',
									)}
									{columns}
									rows={dailyPeriods(result.answer, lang)}
									key={(row) => String(row.start)}
									responsive={{ mode: 'scroll', minWidth: '26rem' }}
								/>
							{:else}
								{@render failure(result)}
								{#if result?.kind !== 'busy'}
									<ul>
										{#each dailyPeriods(null, lang) as row (row.start)}<li>
												{row.label} · {unavailable}
											</li>{/each}
									</ul>
								{/if}
							{/if}
						{/await}
						{#snippet footer()}{#await periodsAnswer then result}{#if result}{@render footerEvidence(
										result,
										'periods',
									)}{/if}{/await}{/snippet}
					</RecordCard>
				</div>

				<div id="messages">
					<RecordCard compactPrint title={t(...dailyTitles.messages)} {stamp}>
						{#if !data.tracked}
							{@render messagesNotTracked()}
						{:else}
							{#await messagesAnswer}
								{#key messagesAnswer}<RecordPending locale={lang} answer={messagesAnswer} />{/key}
							{:then result}
								{@const messages = measure(result)}
								{@const count = messages?.evidence.counts.alerts}
								{#if !messages}{@render failure(result)}
								{:else if messages.state === 'not_tracked'}
									{@render messagesNotTracked()}
								{:else if messages.state !== 'measured'}{@render missingMeasure(messages)}
								{:else if count === 0}
									<p>
										{t(
											'No alerts in the tracked record for these dates.',
											'Aucun avis dans le bilan suivi à ces dates.',
										)}
									</p>
								{:else if data.messagesLimited}<p>{alertDetailsLimit[lang]}</p>
								{:else if messages.evidence.alert_messages?.length}
									<ul class="message-rows">
										{#each messages.evidence.alert_messages as message (JSON.stringify( [message.source, message.id, message.version], ))}
											{@const heading = agencyMessageHeading(message, lang)}
											{@const dates = agencyMessageDates(
												message.periods ?? [],
												lang,
												data.timeZone,
											)}
											<li
												class="message-row grid min-w-0 gap-x-4 border-b border-border py-2 print:py-0.5"
											>
												<div class="flex flex-wrap items-start gap-x-2">
													{#each message.routes.slice(0, 3) as id (id)}
														{@const line = display.lineName(id)}
														<a
															class="inline-flex min-h-11 min-w-11 items-center"
															href={link('/lines/' + encodeURIComponent(id))}
															aria-label={line.spoken}><RoutePlate code={line.number ?? id} /></a
														>
													{/each}
												</div>
												<div class="min-w-0">
													<h3 class="font-semibold" lang={heading.language}>
														{heading.title}
													</h3>
													{#if dates}
														<p class="text-muted-foreground">{dates}</p>
													{/if}
													{#if heading.preview}
														<p
															class="text-muted-foreground print:hidden"
															lang={heading.previewLanguage}
														>
															{heading.preview}
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
										{t(
											'All ' + tally(count, lang) + ' in Service alerts',
											'Les ' + tally(count, lang) + ' dans les avis de service',
										)}
									</a>
								{/if}
							{/await}
						{/if}
						{#snippet footer()}{#await messagesAnswer then result}{#if result}{@render footerEvidence(
										result,
										'messages',
									)}{/if}{/await}{/snippet}
					</RecordCard>
				</div>

				<div id="lines">
					<RecordCard
						compactPrint
						title={t('Lines and stops to inspect', 'Lignes et arrêts à examiner')}
						{stamp}
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
								{formatShare}
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
									{formatShare}
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
						{#snippet footer()}
							{#await rankings then [lines, stops]}
								{@const evidence = rankingEvidence(lines, stops)}
								{#if evidence.versions}
									<p
										class="flex w-full flex-wrap justify-between gap-x-3 border-t border-border pt-2 font-mono text-sm text-muted-foreground"
									>
										{#if evidence.sample}<span>{evidence.sample}</span>{/if}
										<span>{evidence.versions}</span>
										{#if evidence.stale}<span>{evidence.stale}</span>{/if}
									</p>
								{/if}
							{/await}
						{/snippet}
					</RecordCard>
				</div>

				{#await answers.get('punctuality') then result}
					{@const current = measure(result)}
					{@const counts = current?.evidence.counts}
					{@const days = current?.evidence.days_included.length}
					{@const observed = current?.evidence.share_observed}
					<div>
						<AboutFigures
							compactPrint
							title={copy.about}
							fields={[
								{ key: 'period', label: copy.period, text: dateRange(period, lang) },
								{
									key: 'counted',
									label: copy.counted,
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
									text: [
										observed == null
											? null
											: copy.observedShare(
													reportPercent(observed, lang),
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
									key: 'versions',
									label: copy.versions,
									text: current ? methodEvidence(current.evidence, lang, true) : null,
								},
								{
									key: 'source',
									label: copy.source,
									text: [
										copy.feeds(operator ?? cityName),
										copy.recordStart(longDate(RECORD_START, lang)),
									].join(' '),
								},
							]}
							versionsLink={{ href: link('/metrics'), label: copy.method }}
						/>
					</div>
				{/await}
				<div class="hidden print:block report-citation">
					{#await answers.get('punctuality') then result}
						{#if result?.kind === 'answer'}<p>{citationText('punctuality', result)}</p>{/if}
					{/await}
				</div>
			</div>
		{/if}
	</article>
</Surface>

<style>
	.daily-report {
		padding-block-end: var(--space-page-x);
	}
	.report-content {
		grid-template-columns: minmax(0, 1fr);
	}
	.report-pair {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(min(100%, 25rem), 1fr));
		gap: var(--space-card-gap);
	}
	.message-row {
		grid-template-columns: fit-content(30%) minmax(0, 1fr);
	}
	.delivery-rows,
	.message-rows {
		container-type: inline-size;
	}
	@container (max-width: 13rem) {
		.delivery-row,
		.message-row {
			grid-template-columns: minmax(0, 1fr);
		}
		.delivery-row dd {
			text-align: start;
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
		.report-content {
			grid-template-columns: repeat(2, minmax(0, 1fr));
			gap: 0.75rem;
		}
		.report-content > :is(#punctuality, .report-pair, .report-citation) {
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
