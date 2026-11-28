<script lang="ts">
	import { stopDisplayName } from '#lib/site/transitDisplay.ts';
	import RecordScreen from '#lib/features/record/RecordScreen.svelte';
	import RecordGroup from '#lib/features/record/RecordGroup.svelte';
	import { page } from '$app/state';
	import { SvelteURL } from 'svelte/reactivity';
	import { Button } from '@yesid/ui/button';
	import RecordChart from '#lib/features/record/charts/RecordChart.svelte';
	import { Surface } from '@yesid/ui/layout';
	import type { DataTableColumn } from '@yesid/ui/table';
	import RecordDataTable from '#lib/features/record/RecordDataTable.svelte';
	import type { RecordWaiting } from '#lib/features/record/recordWaiting.ts';
	import RecordUnavailable from '#lib/features/record/RecordUnavailable.svelte';
	import { tripCopy } from '#lib/features/trips/trips.copy.ts';
	import { localizeHref } from '#lib/i18n/index.ts';
	import { carryFrameState, frameHref } from '#lib/site/frameState.ts';
	import { transitDisplay } from '#lib/site/transitDisplayContext.ts';
	import {
		agencyName,
		compactServiceDay,
		countedUnit,
		citeDates,
		dateRange,
		delayReading,
		longDate,
		methodEvidence,
		citationSource,
		pageCitation,
		recordPercent,
		recordStamp,
		sampleWithMinimum,
		scheduledClock,
	} from '#lib/site/presenter.ts';
	import {
		departureDays,
		departureLateDetail,
		departureLateSentence,
		departureLateShare,
		departureLateStatement,
		departureTitles,
		unscheduledDepartureDay,
	} from '#lib/features/record/departureDailyText.ts';
	import {
		coverageText,
		delayReadingNotes,
		lastGoodNote,
		recordConnection,
		timingBasis,
	} from '#lib/features/record/recordText.ts';
	import { recordSectionLinks } from '#lib/features/record/recordLinks.ts';
	import { recordState, recordStateFor } from '#lib/features/record/recordStates.ts';
	import { overviewCopy } from '#lib/features/home/overviewRecord.copy.ts';
	import AboutFigures from '#lib/features/record/AboutFigures.svelte';
	import RecordActionGroup from '#lib/features/record/RecordActionGroup.svelte';
	import CiteBlock from '#lib/features/record/CiteBlock.svelte';
	import RecordAnswer from '#lib/features/record/RecordAnswer.svelte';
	import RecordEvidenceLine from '#lib/features/record/RecordEvidenceLine.svelte';
	import RecordCard from '#lib/features/record/RecordCard.svelte';
	import RecordPending from '#lib/features/record/RecordPending.svelte';
	import ScreenTitle from '#lib/features/record/ScreenTitle.svelte';
	import { Skeleton } from '@yesid/ui/skeleton';
	import StateMark from '#lib/features/record/StateMark.svelte';
	import DeparturePredictions from '#lib/features/trips/DeparturePredictions.svelte';
	import { isBeforeTodaysDeparture } from '#lib/features/trips/departureLive.ts';
	import type { EngineResult, RecordAnswer as Answer, RecordSeries } from '#lib/server/engine.ts';
	import { addIsoDays } from '#lib/v1/history/selection.ts';
	import { recoverReadings } from '#lib/features/record/recordRecovery.svelte.ts';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
	const initial = $derived({ sections: data.sections });
	const recovered = recoverReadings(
		() => (data.mode === 'record' ? initial : null),
		() => {
			const { period, identity, day, city } = data;
			return period && identity
				? {
						screen: 'departure',
						id: JSON.stringify([identity.line, identity.direction, identity.departure]),
						city,
						from: period.from,
						to: period.to,
						page: new URLSearchParams({ day }).toString(),
					}
				: null;
		},
	);
	const display = transitDisplay();
	const t = (en: string, fr: string) => (data.lang === 'fr' ? fr : en);
	const line = $derived(data.identity ? display.line(data.identity.line) : undefined);
	const clock = $derived(data.identity ? scheduledClock(data.identity.departure, data.lang) : null);
	const beforeDeparture = $derived(
		data.mode === 'live' &&
			!data.lineMissing &&
			data.identity &&
			isBeforeTodaysDeparture(data.identity.departure, data.provider?.timezone ?? 'UTC'),
	);
	const direction = $derived(
		data.identity
			? display.directionLabel(
					data.identity.direction,
					data.headsigns,
					data.lang,
					data.identity.line,
				)
			: undefined,
	);

	const pinned = $derived.by(() => {
		const url = new SvelteURL(page.url.href);
		url.searchParams.set('provider', data.city);
		if (data.mode === 'record') url.searchParams.set('day', data.day);
		return new URL(frameHref(url, { mode: data.mode, period: data.period }), url);
	});
	const local = (path: string) => carryFrameState(localizeHref(path, data.lang, data.city), pinned);
	const lineHref = $derived(
		data.identity ? local(`/lines/${encodeURIComponent(data.identity.line)}`) : undefined,
	);
	const stopHref = (id: string) => local(`/stop/${encodeURIComponent(id)}`);
	function stopDayHref(id: string) {
		const url = new SvelteURL(stopHref(id), pinned);
		url.hash = 'delivery';
		return frameHref(url, {
			mode: 'record',
			period: { from: data.day, to: data.day, preset: null },
		});
	}
	const recordHref = $derived.by(() => {
		const url = new SvelteURL(pinned);
		url.searchParams.delete('trip');
		return frameHref(url, { mode: 'record', period: data.period });
	});
	const answers = $derived(
		(recovered() ?? data).sections.map(({ section, answer }) => ({
			section,
			answer,
			title: departureTitles[section][data.lang === 'fr' ? 1 : 0],
			links: recordSectionLinks(pinned, section),
		})),
	);

	const term = $derived(overviewCopy[data.lang]);
	const observed = $derived(answers.find(({ section }) => section === 'observed'));
	const cardAnswers = $derived(
		answers.flatMap((entry) =>
			entry.section === 'observed' ? [] : [{ ...entry, section: entry.section }],
		),
	);
	type DepartureAnswer = (typeof answers)[number];
	const missingLine = $derived(
		data.lineMissing && observed
			? Promise.resolve(observed.answer).then(
					(result) =>
						result.kind === 'answer' &&
						!result.lastGood &&
						!result.cacheStale &&
						'cells' in result.answer &&
						result.answer.evidence.days_included.length > 0 &&
						!result.answer.cells.some(
							({ evidence }) =>
								(evidence.counts.scheduled ?? 0) > 0 || (evidence.counts.classified ?? 0) > 0,
						),
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
		return departureLateStatement(answer, data.lang);
	}
	const stop = (id: string) => ({
		name: data.stopNames[id] ? stopDisplayName(data.stopNames[id]) : id,
		code: data.stopCodes[id],
		href: stopHref(id),
	});
	type MissedRow = { id: string; label: string; cancelled: number | null; missing: number | null };
	const shapes = $derived({
		stops: { shape: 'ladder', count: Object.keys(data.stopNames).length },
		delay: { shape: 'facts', count: 2 },
		missed: 'line',
	} satisfies Record<Exclude<(typeof answers)[number]['section'], 'observed'>, RecordWaiting>);
	const predictionsShape = { shape: 'table', rows: 6 } as const;
	const missedColumns = $derived<DataTableColumn<MissedRow>[]>([
		{ key: 'cancelled', header: t('Cancelled', 'Annulés'), numeric: true, cell: cancelled },
		{ key: 'missing', header: t('Missing', 'Manquants'), numeric: true, cell: missing },
	]);
</script>

{#snippet cancelled(row: MissedRow)}{row.cancelled ?? recordState('unknown')[data.lang]}{/snippet}
{#snippet missing(row: MissedRow)}{row.missing ?? recordState('unknown')[data.lang]}{/snippet}

{#snippet connection(result: EngineResult<Answer>, shape: RecordWaiting)}
	{#if result.kind === 'busy'}
		<RecordPending locale={data.lang} busy {shape} />
	{:else if result.kind !== 'answer'}
		<RecordUnavailable
			locale={data.lang}
			retry={result.kind === 'unreachable' ? result.retry : undefined}
		/>
	{/if}
{/snippet}

{#snippet heading()}
	<ScreenTitle
		title={data.seoTitle}
		plate={line}
		subtitle={direction}
		back={lineHref
			? {
					href: lineHref,
					label: t('Line', 'Ligne'),
					compactLabel: t('Line', 'Ligne'),
				}
			: undefined}
		dot={false}
	/>
{/snippet}

{#snippet recordBody(observed: DepartureAnswer)}
	<RecordGroup class="gap-(--space-card-gap) py-(--space-card-gap)">
		<div data-slot="screen-answer" class="departure-answer min-[1280px]:-mb-4">
			{#await observed.answer}
				<RecordPending {heading} locale={data.lang} shape="answer" answer={observed.answer} />
			{:then result}
				{#if result.kind === 'answer' && 'cells' in result.answer}
					{@const answer = result.answer}
					{@const days = departureDays(answer)}
					{@const lateShare = departureLateShare(answer)}
					{@const lateDetail = departureLateDetail(answer, data.lang)}
					{@const absent = recordStateFor(answer.state ?? answer.cells[0]?.state ?? 'not_measured')}
					{@const tooFew = days.observed > 0 && lateShare.share == null}
					<div id="observed">
						<RecordAnswer
							{heading}
							value={lateShare.share == null ? null : recordPercent(lateShare.share, data.lang)}
							state={tooFew ? 'too_few_to_judge' : absent}
							locale={data.lang}
							time={recordTime}
							sentence={lateShare.share != null
								? departureLateSentence(data.lang)
								: recordState(tooFew ? 'too_few_to_judge' : absent)[data.lang]}
							{actions}
						>
							{#snippet meta()}
								{#if tooFew && lateShare.minimum != null}<p>
										{sampleWithMinimum(
											countedUnit(lateShare.classified, 'event', data.lang),
											lateShare.minimum,
											data.lang,
										)}
									</p>
								{:else if lateDetail}<p>{lateDetail}</p>{/if}
							{/snippet}
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
								<CiteBlock
									locale={data.lang}
									text={pageCitation(
										data.seoTitle,
										data.period,
										pinned.href,
										data.lang,
										data.provider
											? citationSource(
													data.provider.labels[data.lang].operator,
													data.provider,
													data.lang,
												)
											: null,
									)}
								/>
							{/snippet}
							{#snippet figures()}
								{#each answers as { section, answer: pending, title, links } (section)}
									{#await pending then entry}
										{#if entry.kind === 'answer'}
											{@const evidence = entry.answer.evidence}
											<CiteBlock
												locale={data.lang}
												text={[
													`Transit · ${data.seoTitle}. ${title}. ${citeDates(
														{ from: evidence.start_date, to: evidence.end_date },
														data.lang,
													)}.`,
													section === 'observed' && days.observed ? observedStatement(answer) : '',
													methodEvidence(evidence, data.lang),
													entry.lastGood ? lastGoodNote[data.lang] : '',
													links.share,
												]
													.filter(Boolean)
													.join(' ')}
											/>
										{/if}
									{/await}
								{/each}
							{/snippet}
						</RecordActionGroup>
					{/snippet}
				{:else if result.kind === 'busy'}
					<RecordPending {heading} locale={data.lang} busy shape="answer" />
				{:else}
					<RecordAnswer
						{heading}
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
		{#each cardAnswers as { section, title: heading, answer } (section)}
			<div id={section} class="min-w-0" class:typical-delay={section === 'delay'}>
				{#snippet dayChoices()}
					{#if section === 'stops'}
						<!-- On paper the card stamp names the chosen date; the date links stay on screen. -->
						<nav
							class="flex flex-wrap gap-2 print:hidden"
							aria-label={t('Service date', 'Date de service')}
						>
							{#if start > 0}
								<Button href={dateHref(dates[start - 1])} variant="outline" class="min-h-11"
									>{t('Earlier dates', 'Dates précédentes')}</Button
								>
							{/if}
							{#each dates.slice(start, start + 7) as day (day)}
								<Button
									href={dateHref(day)}
									variant={day === data.day ? 'default' : 'outline'}
									class="min-h-11 min-w-11"
									aria-current={day === data.day ? 'date' : undefined}
									aria-label={longDate(day, data.lang)}>{compactServiceDay(day, data.lang)}</Button
								>
							{/each}
							{#if dates[start + 7]}
								<Button href={dateHref(dates[start + 7])} variant="outline" class="min-h-11"
									>{t('Later dates', 'Dates suivantes')}</Button
								>
							{/if}
						</nav>
					{/if}
				{/snippet}
				{#await answer}
					<!-- The waiting card holds the answer's size, so nothing moves when it arrives. -->
					<RecordCard
						title={heading}
						stamp={section === 'stops' ? dayTime : recordTime}
						reserve={shapes[section]}
					>
						<div class="grid min-w-0 gap-3">
							{@render dayChoices()}
							<RecordPending locale={data.lang} {answer} shape={shapes[section]} />
						</div>
						{#snippet evidence()}
							<!-- The evidence line's place, filled when the answer comes. -->
							<div class="pending-evidence" aria-hidden="true">
								<Skeleton class="h-4 w-56 max-w-full" />
							</div>
						{/snippet}
					</RecordCard>
				{:then result}
					<RecordCard
						interactive={section === 'stops' && dates.length > 0}
						title={heading}
						stamp={section === 'stops' ? dayTime : recordTime}
						reserve={shapes[section]}
					>
						<div class="grid min-w-0 gap-3">
							{@render dayChoices()}
							{#if result.kind !== 'answer'}
								{@render connection(result, shapes[section])}
							{:else}
								{@const reading = result.answer}
								{#if result.lastGood}<p>{lastGoodNote[data.lang]}</p>{/if}
								{#if section === 'stops' && 'cells' in reading && !result.lastGood && !result.cacheStale && reading.evidence.days_included.includes(data.day) && reading.cells.every(({ evidence }) => evidence.counts.scheduled === 0)}
									<p>{unscheduledDepartureDay(data.day, data.lang)}</p>
								{:else if section === 'stops' && 'cells' in reading && reading.cells.length}
									{@const stopId = reading.cells.find(({ key }) => typeof key.stop === 'string')
										?.key.stop}
									<RecordChart
										input={{ kind: 'ladder', answer: reading, stop, observed: true }}
										title={heading}
										locale={data.lang}
										id="departure-stop-ladder"
									/>
									{#if typeof stopId === 'string'}
										<nav
											class="flex flex-wrap gap-x-4"
											aria-label={t('Stop links', 'Liens vers l’arrêt')}
										>
											<a
												class="inline-flex min-h-11 items-center text-primary underline"
												href={stopHref(stopId)}
											>
												{t(`See stop ${stop(stopId).name}`, `Voir l’arrêt ${stop(stopId).name}`)}
											</a>
											<a
												class="inline-flex min-h-11 items-center text-primary underline"
												href={stopDayHref(stopId)}
											>
												{t(
													'Trips that ran here on this date',
													'Trajets effectués ici à cette date',
												)}
											</a>
										</nav>
									{/if}
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
											<dt>{t(...delayReadingNotes.median.label)}</dt>
											<dd class="font-heading text-heading font-extrabold">
												{delayReading(
													reading.value.median_delay,
													data.lang,
													recordState('unknown')[data.lang],
												)}
											</dd>
											<dd>
												{t(...delayReadingNotes.median.note)}
											</dd>
										</div>
										<div>
											<dt>{t(...delayReadingNotes.latest.label)}</dt>
											<dd class="font-heading text-heading font-extrabold">
												{delayReading(
													reading.value.p90_delay,
													data.lang,
													recordState('unknown')[data.lang],
												)}
											</dd>
											<dd>
												{t(...delayReadingNotes.latest.note)}
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
															id: key.day,
															label: compactServiceDay(key.day, data.lang),
															cancelled: counts.cancelled ?? null,
															missing: counts.missing ?? null,
														},
													]
												: [],
									)}
									{#if rows.length}
										<RecordDataTable
											locale={data.lang}
											title={heading}
											rowHeader={t('Service date', 'Date de service')}
											columns={missedColumns}
											{rows}
											scrollMinWidth="20rem"
											pageSize={0}
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
								{@const count = 'counts' in evidence ? evidence.counts.classified : undefined}
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
											? countedUnit(seriesCount, section === 'missed' ? 'trip' : 'event', data.lang)
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
	{#snippet about(
		evidence?: import('#lib/server/engine.ts').RecordMeasure['evidence'],
		waiting = false,
	)}
		{#if data.period}
			<RecordGroup class="gap-(--space-card-gap) py-(--space-card-gap)">
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
							waitingLines: waiting ? 4 : undefined,
							text: evidence
								? [
										coverageText(evidence, data.lang).replace(/([^.!?])$/, '$1.'),
										timingBasis(evidence.counts, data.lang),
									]
										.filter(Boolean)
										.join(' ')
								: null,
						},
						{
							key: 'counted',
							label: t('Counted', 'Ce qui est compté'),
							text: t(
								'The answer is the late share of the recorded stop arrivals of this departure on these dates. An observed day has at least one classified stop arrival.',
								'La réponse est la part des passages enregistrés de ce départ qui étaient en retard à ces dates. Jour observé : au moins un passage classé.',
							),
						},
						{
							key: 'missed',
							label: t('Cancelled and missing departures', 'Départs annulés et manquants'),
							text: t(
								'Cancelled: the agency announced it. Missing: it was scheduled and no vehicle was seen during continuous capture.',
								'Annulé\u00a0: annoncé par la société de transport. Manquant : départ prévu, sans véhicule vu en collecte continue.',
							),
						},
						{ key: 'means', label: term.means, text: term.definition },
						{
							key: 'method',
							label: t('Method', 'Méthode'),
							text: null,
							link: {
								href: local('/metrics'),
								label: t('How we measure', 'Comment on mesure'),
							},
						},
						{
							key: 'error',
							label: t('Seen an error?', 'Vous avez vu une erreur?'),
							text: null,
							link: {
								href: local('/metrics#about-transit'),
								label: t('About Transit', 'À propos de Transit'),
							},
						},
						{
							key: 'source',
							label: term.source,
							text: data.provider
								? term.feeds(agencyName(data.provider.labels[data.lang].operator, data.provider))
								: null,
						},
					]}
				/>
			</RecordGroup>
		{/if}
	{/snippet}
	{#await answers.find(({ section }) => section === 'delay')?.answer}
		{@render about(undefined, true)}
	{:then result}
		{@render about(
			result?.kind === 'answer' && 'value' in result.answer ? result.answer.evidence : undefined,
			result?.kind === 'busy',
		)}
	{/await}
{/snippet}

<Surface>
	<RecordScreen>
		<div data-slot="screen-content">
			{#if data.mode === 'live'}
				<RecordGroup class="gap-(--space-card-gap) py-(--space-card-gap)">
					<div data-screen-intro class="min-[1280px]:-mb-4">{@render heading()}</div>
					{#await data.liveTrips}
						<div data-slot="screen-answer" class="min-[1280px]:-mb-4">
							<RecordPending locale={data.lang} shape="answer" />
						</div>
						<RecordCard title={tripCopy[data.lang].reportedPredictions}>
							<RecordPending locale={data.lang} shape={predictionsShape} />
						</RecordCard>
					{:then result}
						{@const trips = result?.trips ?? []}
						{@const selected = result?.selected ?? (trips.length === 1 ? trips[0] : null)}
						<div data-slot="screen-answer" class="min-[1280px]:-mb-4">
							{#if selected && data.v1}
								<RecordAnswer
									value={clock}
									sentence={direction ?? t('Reported predictions', 'Prévisions communiquées')}
									locale={data.lang}
								/>
							{:else if !trips.length && beforeDeparture}
								<RecordAnswer
									value={clock}
									sentence={t('Scheduled departure', 'Départ prévu')}
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
								/>{/key}
						{:else}
							<RecordCard title={tripCopy[data.lang].reportedPredictions}>
								{#if !trips.length && beforeDeparture}
									<p>
										{t(
											`This departure is scheduled for ${clock}. Live data appears once its vehicle starts reporting.`,
											`Ce départ est prévu à ${clock}. Les données en direct s’affichent dès que son véhicule commence à transmettre.`,
										)}
									</p>
								{:else}
									<p>{tripCopy[data.lang].noPredictions}</p>
									{#if !trips.length && !data.lineMissing && clock}
										<a
											class="inline-flex min-h-11 items-center text-primary underline"
											href={recordHref}
										>
											{t('See this departure’s Record', 'Voir le bilan de ce départ')}
										</a>
									{/if}
								{/if}
							</RecordCard>
						{/if}
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
				{#await missingLine then missing}
					{#if missing}
						<RecordGroup class="gap-(--space-card-gap) py-(--space-card-gap)">
							<div data-screen-intro class="min-[1280px]:-mb-4">{@render heading()}</div>
							<div data-slot="screen-answer" class="min-[1280px]:-mb-4">
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
					{/if}
				{/await}
				{#if missingLine === false}
					{@render recordBody(observed)}
				{:else}
					{#await missingLine}
						{@render recordBody(observed)}
					{:then missing}
						{#if !missing}{@render recordBody(observed)}{/if}
					{/await}
				{/if}
			{:else}
				<RecordGroup class="gap-(--space-card-gap) py-(--space-card-gap)"
					><div data-screen-intro class="min-[1280px]:-mb-4">{@render heading()}</div></RecordGroup
				>
			{/if}
		</div>
	</RecordScreen>
</Surface>

<style>
	/* The head keeps the answer's rows while it waits: figure and sentence, stamp, counted line and
	   the actions, which wrap under the sentence below 80rem. */
	.departure-answer {
		min-block-size: 26.75rem;
	}
	@media (width >= 40rem) {
		.departure-answer {
			min-block-size: 14.25rem;
		}
	}
	@media (width >= 64rem) {
		.departure-answer {
			min-block-size: 17rem;
		}
	}
	@media (width >= 80rem) {
		.departure-answer {
			min-block-size: 11rem;
		}
	}
	/* Paper holds the answer itself; nothing waits there. */
	@media print {
		.departure-answer {
			min-block-size: 0;
		}
	}
	.pending-evidence {
		display: flex;
		align-items: center;
		min-block-size: 1.375rem;
	}
	.delay-readings {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(min(100%, 8rem), 1fr));
		gap: calc(var(--space-card-gap) / 2);
	}

	@media (width >= 80rem) {
		/* Two delay readings and the evidence line share a stable card slot. */
		.typical-delay {
			display: grid;
			min-block-size: 14rem;
		}
	}
</style>
