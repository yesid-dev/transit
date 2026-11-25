<script lang="ts">
	import { recordPercent } from '#lib/site/presenter.ts';
	import RecordScreen from '#lib/features/record/RecordScreen.svelte';
	import RecordGroup from '#lib/features/record/RecordGroup.svelte';
	import { page } from '$app/state';
	import { SvelteURL } from 'svelte/reactivity';
	import { Button } from '@yesid/ui/button';
	import RecordChart from '#lib/features/record/charts/RecordChart.svelte';
	import { Surface } from '@yesid/ui/layout';
	import { DataTable, type DataTableColumn } from '@yesid/ui/table';
	import { localizeHref } from '#lib/i18n/index.ts';
	import { carryFrameState, frameHref } from '#lib/site/frameState.ts';
	import { transitDisplay } from '#lib/site/transitDisplayContext.ts';
	import {
		compactServiceDay,
		countedUnit,
		dateRange,
		delayReading,
		longDate,
		methodEvidence,
		recordRatio,
		recordStamp,
		scheduledClock,
	} from '#lib/site/presenter.ts';
	import { departureDays, departureTitles } from '#lib/features/record/departureDailyText.ts';
	import {
		coverageText,
		lastGoodNote,
		recordConnection,
		timingBasis,
	} from '#lib/features/record/recordText.ts';
	import { recordSectionLinks } from '#lib/features/record/recordLinks.ts';
	import { recordState, recordStateFor } from '#lib/features/record/recordStates.ts';
	import { overviewCopy } from '#lib/features/home/overviewRecord.copy.ts';
	import AboutFigures from '#lib/features/record/AboutFigures.svelte';
	import RecordActionGroup from '#lib/features/record/RecordActionGroup.svelte';
	import RecordAnswer from '#lib/features/record/RecordAnswer.svelte';
	import RecordEvidenceLine from '#lib/features/record/RecordEvidenceLine.svelte';
	import RecordCard from '#lib/features/record/RecordCard.svelte';
	import RecordPending from '#lib/features/record/RecordPending.svelte';
	import ScreenTitle from '#lib/features/record/ScreenTitle.svelte';
	import StateMark from '#lib/features/record/StateMark.svelte';
	import DeparturePredictions from '#lib/features/trips/DeparturePredictions.svelte';
	import type { EngineResult, RecordAnswer as Answer, RecordSeries } from '#lib/server/engine.ts';
	import { addIsoDays } from '#lib/v1/history/selection.ts';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
	const display = transitDisplay();
	const t = (en: string, fr: string) => (data.lang === 'fr' ? fr : en);
	const line = $derived(data.identity ? display.line(data.identity.line) : undefined);
	const clock = $derived(data.identity ? scheduledClock(data.identity.departure, data.lang) : null);
	const direction = $derived(
		data.identity
			? display.directionLabel(data.identity.direction, data.headsigns, data.lang)
			: undefined,
	);

	const pinned = $derived.by(() => {
		const url = new SvelteURL(page.url.href);
		url.searchParams.set('provider', data.city);
		if (data.mode === 'record') url.searchParams.set('day', data.day);
		return new URL(
			frameHref(url, { mode: data.mode, period: data.period && { ...data.period, preset: null } }),
			url,
		);
	});
	const local = (path: string) => carryFrameState(localizeHref(path, data.lang, data.city), pinned);
	const lineHref = $derived(
		data.identity ? local(`/lines/${encodeURIComponent(data.identity.line)}`) : undefined,
	);
	const stopHref = (id: string) => local(`/stop/${encodeURIComponent(id)}`);
	const answers = $derived(
		data.sections.map(({ section, answer }) => ({
			section,
			answer,
			title: departureTitles[section][data.lang === 'fr' ? 1 : 0],
			links: recordSectionLinks(pinned, section),
		})),
	);

	const term = $derived(overviewCopy[data.lang]);
	const observed = $derived(answers.find(({ section }) => section === 'observed'));
	const missingLine = $derived(
		data.lineMissing && observed
			? observed.answer.then(
					(result) =>
						result.kind !== 'busy' &&
						(result.kind !== 'answer' ||
							!('cells' in result.answer) ||
							!result.answer.cells.some(
								({ evidence }) =>
									(evidence.counts.scheduled ?? 0) > 0 || (evidence.counts.classified ?? 0) > 0,
							)),
				)
			: false,
	);
	const recordTime = $derived(
		data.period
			? { kind: 'record' as const, label: recordStamp(data.period, data.lang) }
			: undefined,
	);
	const dayTime = $derived({
		kind: 'record' as const,
		label: recordStamp({ from: data.day, to: data.day }, data.lang),
	});
	const dates = $derived.by(() => {
		const days: string[] = [];
		if (data.period)
			for (let day = data.period.from; day <= data.period.to; day = addIsoDays(day, 1))
				days.push(day);
		return days;
	});
	const start = $derived(Math.max(0, Math.floor(dates.indexOf(data.day) / 7) * 7));

	function dateHref(day: string) {
		const url = new SvelteURL(pinned);
		url.searchParams.set('day', day);
		url.hash = 'stops';
		return url.pathname + url.search + url.hash;
	}
	function departureLink(id: string) {
		const url = new SvelteURL(pinned);
		url.searchParams.set('trip', id);
		return url.pathname + url.search;
	}
	function observedStatement(answer: RecordSeries) {
		const { late, observed } = departureDays(answer);
		return t(
			`${late} of ${observed} observed days had a late stop.`,
			`Au moins un retard à un arrêt sur ${late} des ${observed} jours observés.`,
		);
	}
	const stop = (id: string) => ({
		name: data.stopNames[id] || id,
		code: data.stopCodes[id],
		href: stopHref(id),
	});
	type MissedRow = { day: string; cancelled: number | null; missing: number | null };
	const missedColumns = $derived<DataTableColumn<MissedRow>[]>([
		{ key: 'day', header: t('Service date', 'Date de service'), rowHeader: true, cell: missedDay },
		{ key: 'cancelled', header: t('Cancelled', 'Annulés'), numeric: true, cell: cancelled },
		{ key: 'missing', header: t('Missing', 'Manquants'), numeric: true, cell: missing },
	]);
</script>

{#snippet missedDay(row: MissedRow)}{compactServiceDay(row.day, data.lang)}{/snippet}
{#snippet cancelled(row: MissedRow)}{row.cancelled ?? recordState('unknown')[data.lang]}{/snippet}
{#snippet missing(row: MissedRow)}{row.missing ?? recordState('unknown')[data.lang]}{/snippet}

{#snippet connection(result: EngineResult<Answer>)}
	{#if result.kind === 'busy'}
		<RecordPending locale={data.lang} busy />
	{:else if result.kind !== 'answer'}
		<p>{recordConnection[result.kind][data.lang]}</p>
	{/if}
{/snippet}

<Surface>
	<RecordScreen>
		<RecordGroup>
			<ScreenTitle
				title={data.seoTitle}
				plate={line}
				subtitle={direction}
				back={lineHref ? { href: lineHref, label: t('See the line', 'Voir la ligne') } : undefined}
			/>
		</RecordGroup>
		<div data-slot="screen-content">
			{#if data.mode === 'live'}
				<RecordGroup density="compact">
					{#await data.liveTrips}
						<RecordPending locale={data.lang} />
					{:then result}
						{@const trips = result?.trips ?? []}
						{@const selected = result?.selected ?? (trips.length === 1 ? trips[0] : null)}
						<div data-slot="screen-answer">
							{#if selected && data.v1}
								<RecordAnswer
									value={clock}
									sentence={direction ?? t('Reported predictions', 'Prévisions communiquées')}
									locale={data.lang}
								/>
							{:else}
								<RecordAnswer
									value={null}
									state="no_live_data"
									locale={data.lang}
									sentence={trips.length
										? t(
												'Choose a trip to see its predictions.',
												'Choisissez un trajet pour voir ses prévisions.',
											)
										: t(
												'No live data for this departure today.',
												'Aucune donnée en direct pour ce départ aujourd’hui.',
											)}
								/>
							{/if}
						</div>
						{#if selected && data.v1}{#key selected}<DeparturePredictions
									id={selected}
									locale={data.lang}
									stopNames={data.stopNames}
								/>{/key}{/if}
						{#if trips.length > 1}
							<ul class="grid gap-2">
								{#each trips as id (id)}
									<li>
										<a
											class="inline-flex min-h-11 items-center text-primary underline"
											href={departureLink(id)}
										>
											{t(
												`Prediction report for trip ${id}`,
												`Rapport de prévisions du trajet ${id}`,
											)}
										</a>
									</li>
								{/each}
							</ul>
						{/if}
					{/await}
				</RecordGroup>
			{:else if observed}
				{#await missingLine}
					<RecordGroup>
						<div data-slot="screen-answer">
							<RecordPending locale={data.lang} answer={observed.answer} />
						</div>
					</RecordGroup>
				{:then missing}
					{#if missing}
						<RecordGroup>
							<div data-slot="screen-answer">
								<RecordAnswer
									value={null}
									state="unknown"
									locale={data.lang}
									sentence={t(
										'This line is not in the current timetable.',
										'Cette ligne ne figure pas à l’horaire actuel.',
									)}
								/>
							</div>
						</RecordGroup>
					{:else}
						<RecordGroup density="compact">
							<div data-slot="screen-answer">
								{#await observed.answer}
									<RecordPending locale={data.lang} answer={observed.answer} />
								{:then result}
									{#if result.kind === 'answer' && 'cells' in result.answer}
										{@const answer = result.answer}
										{@const days = departureDays(answer)}
										{@const absent = recordStateFor(
											answer.state ?? answer.cells[0]?.state ?? 'not_measured',
										)}
										<div id="observed">
											<RecordAnswer
												value={days.observed
													? recordRatio(days.late, String(days.observed), data.lang)
													: null}
												state={absent}
												locale={data.lang}
												time={recordTime}
												sentence={days.observed
													? t(
															'observed days had a late stop.',
															'jours observés avec au moins un retard.',
														)
													: recordState(absent)[data.lang]}
												{actions}
											>
												{#snippet meta()}<p class="font-mono text-small text-muted-foreground">
														{methodEvidence(answer.evidence, data.lang, true)}
													</p>{/snippet}
											</RecordAnswer>
										</div>
										{#snippet actions()}
											<RecordActionGroup
												locale={data.lang}
												href={pinned.href}
												files={answers.map(({ links, title }) => ({
													href: links.csv,
													label: title,
												}))}
											>
												{#snippet citation()}
													{#each answers as { section, answer: pending, title, links } (section)}
														{#await pending then entry}
															{#if entry.kind === 'answer'}
																{@const evidence = entry.answer.evidence}
																<p>
																	Transit · {data.seoTitle}. {title}. {dateRange(
																		{ from: evidence.start_date, to: evidence.end_date },
																		data.lang,
																	)}.
																	{section === 'observed' && days.observed
																		? observedStatement(answer)
																		: ''}
																	{methodEvidence(evidence, data.lang)}
																	{entry.lastGood ? lastGoodNote[data.lang] : ''}
																	{links.share}
																</p>
															{/if}
														{/await}
													{/each}
												{/snippet}
											</RecordActionGroup>
										{/snippet}
									{:else if result.kind === 'busy'}
										<RecordPending locale={data.lang} busy />
									{:else}
										<RecordAnswer
											value={null}
											state="unknown"
											sentence={result.kind === 'answer'
												? recordState('unknown')[data.lang]
												: recordConnection[result.kind][data.lang]}
											locale={data.lang}
											time={recordTime}
										/>
									{/if}
								{/await}
							</div>
							{#each answers.filter(({ section }) => section !== 'observed') as { section, title: heading, answer } (section)}
								<div id={section} class="min-w-0">
									{#await answer}
										<RecordCard title={heading} stamp={section === 'stops' ? dayTime : recordTime}>
											<RecordPending locale={data.lang} {answer} />
										</RecordCard>
									{:then result}
										<RecordCard
											interactive={section === 'stops' && dates.length > 0}
											title={heading}
											stamp={section === 'stops' ? dayTime : recordTime}
										>
											<div class="grid min-w-0 gap-3">
												{#if section === 'stops'}
													<nav
														class="flex flex-wrap gap-2"
														aria-label={t('Service date', 'Date de service')}
													>
														{#if start > 0}
															<Button
																href={dateHref(dates[start - 1])}
																variant="outline"
																class="min-h-11">{t('Earlier dates', 'Dates précédentes')}</Button
															>
														{/if}
														{#each dates.slice(start, start + 7) as day (day)}
															<Button
																href={dateHref(day)}
																variant={day === data.day ? 'default' : 'outline'}
																class="min-h-11 min-w-11"
																aria-current={day === data.day ? 'date' : undefined}
																aria-label={longDate(day, data.lang)}
																>{compactServiceDay(day, data.lang)}</Button
															>
														{/each}
														{#if dates[start + 7]}
															<Button
																href={dateHref(dates[start + 7])}
																variant="outline"
																class="min-h-11">{t('Later dates', 'Dates suivantes')}</Button
															>
														{/if}
													</nav>
												{/if}
												{#if result.kind !== 'answer'}
													{@render connection(result)}
												{:else}
													{@const reading = result.answer}
													{#if result.lastGood}<p>{lastGoodNote[data.lang]}</p>{/if}
													{#if section === 'stops' && 'cells' in reading && reading.cells.length}
														<RecordChart
															formatShare={recordPercent}
															input={{ kind: 'ladder', answer: reading, stop, observed: true }}
															title={heading}
															locale={data.lang}
															id="departure-stop-ladder"
														/>
														{#if reading.cells.some((cell) => cell.evidence.observed_delay_seconds == null && (cell.state !== 'measured' || cell.value.median_delay == null))}
															<p class="text-small text-muted-foreground">
																{t(
																	'A stop needs a usable reading to show an observed delay.',
																	'Un passage doit avoir une lecture utilisable pour afficher le retard observé.',
																)}
															</p>
														{/if}
													{:else if section === 'delay' && 'value' in reading && reading.state === 'measured'}
														<dl class="delay-readings">
															<div>
																<dt>{t('Median delay', 'Retard médian')}</dt>
																<dd class="font-heading text-heading font-extrabold">
																	{delayReading(
																		reading.value.median_delay,
																		data.lang,
																		recordState('unknown')[data.lang],
																	)}
																</dd>
																<dd>
																	{t(
																		'Half of the vehicles were later than this.',
																		'La moitié des véhicules sont passés plus tard.',
																	)}
																</dd>
															</div>
															<div>
																<dt>{t('90th percentile', '90e centile')}</dt>
																<dd class="font-heading text-heading font-extrabold">
																	{delayReading(
																		reading.value.p90_delay,
																		data.lang,
																		recordState('unknown')[data.lang],
																	)}
																</dd>
																<dd>
																	{t(
																		'1 vehicle in 10 was later than this.',
																		'1 véhicule sur 10 est passé plus tard.',
																	)}
																</dd>
															</div>
														</dl>
													{:else if section === 'missed' && 'cells' in reading && reading.cells.some(({ evidence }) => (evidence.counts.eligible ?? 0) > 0)}
														{@const rows = reading.cells.flatMap(
															({ key, evidence: { counts } }): MissedRow[] =>
																typeof key.day === 'string' &&
																(counts.cancelled ?? 0) + (counts.missing ?? 0) > 0
																	? [
																			{
																				day: key.day,
																				cancelled: counts.cancelled ?? null,
																				missing: counts.missing ?? null,
																			},
																		]
																	: [],
														)}
														{#if rows.length}
															<DataTable
																caption={heading}
																columns={missedColumns}
																{rows}
																key={(row) => row.day}
																responsive={{ mode: 'scroll', minWidth: '20rem' }}
															/>
														{:else}
															<p>
																{t(
																	'No cancellations or missing trips among the departures with known status.',
																	'Aucun trajet annulé ou manquant parmi les départs dont l’état est connu.',
																)}
															</p>
														{/if}
													{:else}
														<StateMark state={recordStateFor(reading.state)} locale={data.lang} />
													{/if}
												{/if}
											</div>
											{#snippet evidence()}
												{#if result.kind === 'answer'}
													{@const evidence = result.answer.evidence}
													{@const count =
														'counts' in evidence ? evidence.counts.classified : undefined}
													{@const seriesCount =
														'cells' in result.answer
															? result.answer.cells.reduce(
																	(sum, cell) =>
																		sum +
																		(section === 'missed'
																			? (cell.evidence.counts.eligible ?? 0)
																			: (cell.evidence.counts.classified ?? 0)),
																	0,
																)
															: null}
													<RecordEvidenceLine
														{evidence}
														sample={count
															? countedUnit(count, 'event', data.lang)
															: seriesCount
																? countedUnit(
																		seriesCount,
																		section === 'missed' ? 'trip' : 'event',
																		data.lang,
																	)
																: null}
														locale={data.lang}
													/>
												{/if}
											{/snippet}
										</RecordCard>
									{/await}
								</div>
							{/each}
						</RecordGroup>
						{#await answers.find(({ section }) => section === 'delay')?.answer then result}
							{#if data.period && result?.kind === 'answer' && 'value' in result.answer}
								{@const evidence = result.answer.evidence}
								<RecordGroup>
									<AboutFigures
										compact
										title={t('About these figures', 'À propos de ces chiffres')}
										fields={[
											{
												key: 'period',
												label: t('Period', 'Période'),
												text: dateRange(data.period, data.lang),
											},
											{
												key: 'observed',
												label: t('Observed', 'Observations'),
												text: [
													coverageText(evidence, data.lang, recordPercent).replace(
														/([^.!?])$/,
														'$1.',
													),
													timingBasis(evidence.counts, data.lang, recordPercent),
												]
													.filter(Boolean)
													.join(' '),
											},
											{
												key: 'counted',
												label: t('Counted', 'Décompte'),
												text: t(
													'An observed day has at least one classified stop event. The answer counts days with at least one observed late stop.',
													'Jour observé : au moins un passage classé. Le bilan compte les jours avec un retard observé à un arrêt.',
												),
											},
											{
												key: 'missed',
												label: t(
													'Cancelled and missing departures',
													'Départs annulés et manquants',
												),
												text: t(
													'Cancelled: the agency announced it. Missing: it was scheduled and no vehicle was seen during continuous capture.',
													'Annulé : annoncé par l’agence. Manquant : départ prévu, sans véhicule vu en collecte continue.',
												),
											},
											{ key: 'means', label: term.means, text: term.definition },
											{
												key: 'versions',
												label: t('Versions', 'Versions'),
												text: methodEvidence(evidence, data.lang),
											},
											{
												key: 'source',
												label: term.source,
												text: data.provider
													? term.feeds(data.provider.labels[data.lang].operator)
													: null,
											},
										]}
										versionsLink={{
											href: local('/metrics'),
											label: t('How we measure', 'Comment on mesure'),
										}}
									/>
								</RecordGroup>
							{/if}
						{/await}
					{/if}
				{/await}
			{/if}
		</div>
	</RecordScreen>
</Surface>

<style>
	.delay-readings {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(min(100%, 8rem), 1fr));
		gap: calc(var(--space-card-gap) / 2);
	}
</style>
