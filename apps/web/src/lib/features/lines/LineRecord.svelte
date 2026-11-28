<script lang="ts">
	import { tick, untrack, type Snippet } from 'svelte';
	import { MediaQuery } from 'svelte/reactivity';
	import {
		pendingBlockSize,
		skeletonBlockSize,
		type RecordWaiting,
	} from '../record/recordWaiting.ts';
	import { isSettled, type Awaitable, type Ready } from '#lib/site/ready.ts';
	import { page } from '$app/state';
	import RecordGroup from '#lib/features/record/RecordGroup.svelte';
	import { Button } from '@yesid/ui/button';

	import { localizeHref, type Locale } from '#lib/i18n/index.ts';
	import AboutFigures from '#lib/features/record/AboutFigures.svelte';
	import RecordCard from '#lib/features/record/RecordCard.svelte';
	import RecordPending from '#lib/features/record/RecordPending.svelte';
	import RecordSkeleton from '#lib/features/record/RecordSkeleton.svelte';
	import RecordUnavailable from '#lib/features/record/RecordUnavailable.svelte';

	import StateMark from '#lib/features/record/StateMark.svelte';
	import { chartState } from '#lib/features/record/charts/recordCharts.ts';
	import RecordChartToggle from '#lib/features/record/charts/RecordChartToggle.svelte';
	import {
		choose,
		lastGoodNote,
		recordMessage,
		tally,
		timingBasis,
	} from '#lib/features/record/recordText.ts';
	import {
		agencyName,
		alertsNotPublishedLine,
		officialAlertsLabel,
		recordPercent,
		dateRange,
		recordStamp,
	} from '#lib/site/presenter.ts';
	import { providerHasAlerts } from '#lib/site/providerCapabilities.ts';
	import type { loadLineRecord, LineSection } from '#lib/server/lineRecord.ts';
	import type { EngineResult, RecordAnswer, RecordMeasure } from '#lib/server/engine.ts';
	import { carryFrameState, frameHref } from '#lib/site/frameState.ts';
	import { overviewCopy } from '../home/overviewRecord.copy.ts';
	import LineRecordReadings from './LineRecordReadings.svelte';
	import LineRecordTop from './LineRecordTop.svelte';
	import LineScheduleCard from './LineScheduleCard.svelte';
	import LineMeasurementLimits from './LineMeasurementLimits.svelte';
	import LineRecordEvidence, { lineEvidenceSample } from './LineRecordEvidence.svelte';
	import LineStopLadder from './LineStopLadder.svelte';
	import { lineSectionTitles, lineTimetableOnly, lineViewHref } from './lineRecordText.ts';

	let {
		heading,
		outsideTimetable,
		name,

		scheduleOnly,
		locale,
		url,
		record: requested,
		headsigns,
		stopNames,
		stopCodes,
		operator,
	}: {
		heading: Snippet;
		outsideTimetable: boolean;
		name: string;

		scheduleOnly?: boolean;
		locale: Locale;
		url: URL;
		record: Ready<ReturnType<typeof loadLineRecord>>;
		headsigns: Record<number, string>;
		stopNames: Record<string, string>;
		stopCodes: Record<string, string>;
		operator: string;
	} = $props();

	// Keep an already settled period on screen while its replacement is being read.
	// A different line or direction must never inherit the old readings.
	let settled = $state.raw<typeof requested>();
	const sameLine = $derived(
		settled?.city === requested.city &&
			settled.line === requested.line &&
			settled.direction === requested.direction,
	);
	const replacing = $derived(
		sameLine &&
			settled &&
			(settled.period.from !== requested.period.from || settled.period.to !== requested.period.to),
	);
	const record = $derived(replacing && settled ? settled : requested);
	let screen = $state<HTMLDivElement>();
	async function keepReadingPosition() {
		if (window.scrollY === 0 || !screen) return;
		const visible = [...screen.querySelectorAll<HTMLElement>('[data-slot="record-card"]')].find(
			(card) => card.getBoundingClientRect().bottom > 120,
		);
		if (!visible) return;
		const top = visible.getBoundingClientRect().top;
		await tick();
		if (!visible.isConnected) return;
		// The resolved await blocks can undo their pending stubs in a subsequent microtask.
		requestAnimationFrame(() => {
			if (visible.isConnected) window.scrollBy(0, visible.getBoundingClientRect().top - top);
		});
	}
	$effect(() => {
		const next = requested;
		let active = true;
		void Promise.allSettled([
			...next.sections.map(({ answer }) => answer),
			next.directionalFrequency,
			next.network,
			next.networkDaily,
		]).then(() => {
			if (!active) return;
			if (replacing) void keepReadingPosition();
			settled = next;
		});
		return () => {
			active = false;
		};
	});
	const timetableOnlyOf = (result: EngineResult<RecordAnswer>) =>
		result.kind === 'answer' && 'value' in result.answer && lineTimetableOnly(result.answer);
	// A reading drawn on the server decides at once, on the server and on hydration alike.
	let timetableOnly = $state(
		untrack(() => {
			const first = record.sections.find(({ section }) => section === 'punctuality')?.answer;
			return !scheduleOnly && !!first && isSettled(first) && timetableOnlyOf(first);
		}),
	);
	$effect(() => {
		if (scheduleOnly) return;
		const pending = punctualityAnswer;
		if (isSettled(pending)) {
			timetableOnly = timetableOnlyOf(pending);
			return;
		}
		let active = true;
		void pending.then((result) => {
			if (active) timetableOnly = timetableOnlyOf(result);
		});
		return () => {
			active = false;
		};
	});
	const wide = new MediaQuery('(min-width: 40rem)', true);
	const stopRows = $derived(Object.keys(stopNames).length);
	const shapes = $derived({
		stops: { shape: 'ladder', count: stopRows },
		delivery: 'line',
		late: { shape: 'rows', count: 8, lines: 2, lead: 'none' },
		waiting: { shape: 'facts', count: 4 },
		offered: { shape: 'table', rows: 7 },
		crowding: { shape: 'table', rows: 6 },
		alerts: { shape: 'notice', count: 2 },
	} satisfies Partial<Record<LineSection, RecordWaiting>>);

	const t = (en: string, fr: string) => choose(locale, en, fr);
	const title = (section: LineSection) => t(...lineSectionTitles[section]);
	const term = $derived(overviewCopy[locale]);
	const pinned = $derived.by(() => {
		const link = lineViewHref(url, 'record', record.direction);
		link.searchParams.set('provider', record.city);
		return new URL(
			frameHref(link, { mode: 'record', period: { ...record.period, preset: null } }),
			url,
		);
	});
	const link = (path: string) => carryFrameState(localizeHref(path, locale, record.city), pinned);
	const corridorMap = $derived.by(() => {
		const target = new URL(localizeHref('/map', locale, record.city), pinned);
		target.searchParams.set('mapLayer', 'corridors');
		target.searchParams.set('recordLine', record.line);
		if (record.direction != null) target.searchParams.set('recordDirection', record.direction);
		return frameHref(target, { mode: 'record', period: { ...record.period, preset: null } });
	});
	const stamp = $derived({ kind: 'record' as const, label: recordStamp(record.period, locale) });
	const answerFor = (section: LineSection) =>
		record.sections.find((item) => item.section === section)!.answer;
	const stopsAnswer = $derived(answerFor('stops'));

	const punctualityAnswer = $derived(answerFor('punctuality'));
	const failures = ['stops', 'delivery', 'late', 'waiting', 'offered', 'crowding'] as const;
	let chosen = $state<Partial<Record<(typeof failures)[number], boolean>>>({});
	const opened = (section: (typeof failures)[number]) =>
		chosen[section] ?? (section === 'delivery' || wide.current);
	const anyOpen = $derived(failures.some((section) => section !== 'delivery' && opened(section)));
	let stopsTable = $state(false);

	function disclosureBlockSize(section: (typeof failures)[number]) {
		const body = pendingBlockSize(shapes[section])?.wide;
		const chart = skeletonBlockSize('trend');
		return section === 'offered' && body && chart ? `calc(${chart} + 1rem + ${body})` : body;
	}

	function toggleAll() {
		const open = !anyOpen;
		for (const section of failures) chosen[section] = open;
	}
</script>

{#snippet pending(
	answer: Awaitable<EngineResult<RecordAnswer>> | undefined,
	section: keyof typeof shapes,
	busy = false,
)}
	{#key answer}
		{#if section === 'offered'}
			<div class="mb-4"><RecordSkeleton shape="trend" /></div>
		{/if}
		<RecordPending {locale} {answer} {busy} shape={shapes[section]} />
	{/key}
{/snippet}

{#snippet gap(result: EngineResult<RecordAnswer>, section: keyof typeof shapes)}
	{#if result.kind === 'busy'}
		{@render pending(undefined, section, true)}
	{:else if result.kind !== 'answer'}
		<RecordUnavailable {locale} retry={result.kind === 'unreachable' ? result.retry : undefined} />
	{:else}
		<p>
			<StateMark
				state={chartState('state' in result.answer ? result.answer.state : undefined)}
				{locale}
				hiddenLabel
			/>
			{recordMessage(result, locale)}
		</p>
	{/if}
{/snippet}

{#snippet reading(section: keyof typeof shapes)}
	{@const answer = answerFor(section)}
	{#await answer}
		{@render pending(answer, section)}
	{:then result}
		{@const explainsUntracked =
			result.kind === 'answer' &&
			'value' in result.answer &&
			result.answer.state === 'not_tracked' &&
			(section === 'alerts' || section === 'crowding')}
		{#if result.kind === 'answer' && (explainsUntracked || !recordMessage(result, locale))}
			{#if section === 'stops' && 'cells' in result.answer}
				<LineStopLadder
					series={result.answer}
					title={title(section)}
					{locale}
					{headsigns}
					{stopNames}
					{stopCodes}
					{pinned}
					city={record.city}
					table={stopsTable}
				/>
			{:else}
				<LineRecordReadings
					answer={result.answer}
					{section}
					{locale}
					title={title(section)}
					{headsigns}
					url={pinned}
					line={record.line}
					city={record.city}
					{stopNames}
					{operator}
				/>
			{/if}
			{#if result.lastGood}<p class="mt-3 text-small text-muted-foreground">
					{lastGoodNote[locale]}
				</p>{/if}
		{:else}{@render gap(result, section)}{/if}
	{/await}
{/snippet}

{#snippet sectionEvidence(section: LineSection)}
	{@const answer = answerFor(section)}
	{#await answer then result}
		{#if result.kind === 'answer'}<LineRecordEvidence
				evidence={result.answer.evidence}
				{locale}
			/>{/if}
	{/await}
{/snippet}

{#snippet failureGroup()}
	<section aria-labelledby="line-failures-heading" class="grid min-w-0 gap-(--space-card-gap)">
		<div class="flex flex-wrap items-center justify-between gap-2">
			<h2 id="line-failures-heading" class="text-heading font-bold">
				{t('Where and when it fails', 'Où et quand le service fait défaut')}
			</h2>
			<Button variant="outline" size="sm" class="min-h-11" onclick={toggleAll}
				>{anyOpen ? t('Collapse all', 'Tout replier') : t('Expand all', 'Tout déplier')}</Button
			>
		</div>
		{#each failures as section (section)}
			<div
				id={section}
				class="min-w-0"
				class:initially-closed={section !== 'delivery' && chosen[section] === undefined}
			>
				<RecordCard
					title={title(section)}
					{stamp}
					interactive
					expandable
					bind:open={() => opened(section), (open) => (chosen[section] = open ?? false)}
				>
					<div data-slot="line-disclosure-body" style:min-block-size={disclosureBlockSize(section)}>
						{@render reading(section)}
					</div>
					{#snippet evidence()}
						{@render sectionEvidence(section)}
					{/snippet}
					{#snippet toggle()}
						{#if section === 'stops'}
							{#await stopsAnswer then result}
								{#if result.kind === 'answer' && 'cells' in result.answer && result.answer.cells.length}
									<RecordChartToggle bind:table={stopsTable} controls="line-stop-ladder" {locale} />
								{/if}
							{/await}
						{/if}
					{/snippet}
				</RecordCard>
			</div>
		{/each}
	</section>
{/snippet}

{#snippet about(answer: RecordMeasure | null, waiting = false)}
	<AboutFigures
		title={term.about}
		fields={[
			{ key: 'period', label: term.period, text: dateRange(record.period, locale) },
			{
				key: 'counted',
				label: term.counted,
				waitingLines: waiting ? 2 : undefined,
				// This screen's own count; how counting weighs lines lives on How we measure (S5).
				text: answer
					? `${name}${locale === 'fr' ? '\u00a0: ' : ': '}${lineEvidenceSample(answer.evidence, locale)}.`
					: null,
			},
			{
				key: 'observed',
				label: term.observed,
				waitingLines: waiting ? 5 : undefined,
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
			{ key: 'means', label: term.means, text: term.definition },
			{
				key: 'method',
				label: term.methodRow,
				text: null,
				link: { href: link('/metrics'), label: term.method },
			},
			{
				key: 'source',
				label: term.source,
				text: term.feeds(agencyName(operator, page.data.provider)),
			},
			{
				key: 'error',
				label: t('Seen an error?', 'Vous avez vu une erreur?'),
				text: null,
				link: {
					href: link('/metrics#about-transit'),
					label: t('About Transit', 'À propos de Transit'),
				},
			},
		]}
	/>
	<a class="inline-flex min-h-11 w-fit items-center text-primary underline" href={corridorMap}
		>{t('See corridors on the map', 'Voir les corridors sur la carte')}</a
	>
{/snippet}

<div
	data-slot="screen-content"
	class="line-record-content min-w-0"
	bind:this={screen}
	aria-busy={replacing || undefined}
>
	{#if replacing}
		<div data-screen-intro class="sr-only"><RecordPending {locale} /></div>
	{/if}
	<RecordGroup class="gap-(--space-card-gap) py-(--space-card-gap)">
		{#if outsideTimetable}
			<div data-screen-intro class="min-[1280px]:-mb-4">{@render heading()}</div>
		{/if}
		<LineRecordTop
			heading={outsideTimetable ? undefined : heading}
			{name}
			{scheduleOnly}
			{timetableOnly}
			{locale}
			{record}
			{pinned}
			{headsigns}
			{operator}
		/>
		{#if scheduleOnly}
			<LineScheduleCard {record} {locale} {url} {headsigns} />
		{:else if !timetableOnly}
			{@render failureGroup()}
		{/if}
	</RecordGroup>
	{#if scheduleOnly}
		<RecordGroup class="gap-(--space-card-gap) py-(--space-card-gap)"
			><LineMeasurementLimits {locale} methodHref={link('/metrics')} /></RecordGroup
		>
	{:else}
		<RecordGroup class="gap-(--space-card-gap) py-(--space-card-gap)">
			<LineScheduleCard {record} {locale} {url} {headsigns} />
			{#if !timetableOnly}
				<div id="alerts">
					<RecordCard interactive title={title('alerts')} {stamp} reserve={shapes.alerts}>
						{#if !providerHasAlerts(page.data.provider)}
							{@const official = page.data.provider?.alert_links[locale]}
							<p>
								{alertsNotPublishedLine(
									agencyName(operator, page.data.provider),
									locale,
									Boolean(official),
								)}
							</p>
							{#if official}<a
									class="inline-flex min-h-11 items-center text-primary underline"
									href={official}>{officialAlertsLabel(locale)}</a
								>{/if}
						{:else}{@render reading('alerts')}{/if}
						{#snippet evidence()}{#if providerHasAlerts(page.data.provider)}{@render sectionEvidence(
									'alerts',
								)}{/if}{/snippet}
					</RecordCard>
				</div>
			{/if}
		</RecordGroup>
		{#if !timetableOnly}
			<RecordGroup class="gap-(--space-card-gap) py-(--space-card-gap)">
				{#await punctualityAnswer}
					{@render about(null, true)}
				{:then result}
					{@render about(
						result.kind === 'answer' && 'value' in result.answer ? result.answer : null,
						result.kind === 'busy',
					)}
				{/await}
			</RecordGroup>
		{/if}
	{/if}
</div>

<style>
	.line-record-content {
		overflow-anchor: none;
	}
	@media (width < 40rem) {
		/* The first HTML frame follows the phone's closed state before matchMedia is available. */
		.initially-closed :global([data-slot='record-disclosure-content']),
		.initially-closed :global([data-slot='record-card'] > footer) {
			display: none;
		}
	}
	[aria-busy='true'] > :global(.record-group) {
		opacity: 0.65;
	}
</style>
