<script lang="ts">
	import { page } from '$app/state';
	import { RoutePlate, type StampProps } from '@yesid/ui/brand';
	import { StateNotice } from '@yesid/ui/feedback';
	import { Surface } from '@yesid/ui/layout';
	import { ShowMore } from '@yesid/ui/table';
	import { onMount, untrack } from 'svelte';
	import { localizeHref } from '#lib/i18n/routing.ts';
	import type { Locale } from '#lib/i18n/index.ts';
	import type {
		RecordAnswer as EngineAnswer,
		EngineResult,
		RecordEvidence,
		RecordMeasure,
	} from '#lib/server/engine.ts';
	import type { loadAlertRecord } from '#lib/server/alertRecord.ts';
	import { frameHref } from '#lib/site/frameState.ts';
	import {
		alertAnswerSentence,
		alertPaging,
		dateRange,
		liveStampAge,
		methodEvidence,
		recordStamp,
	} from '#lib/site/presenter.ts';
	import { transitDisplay } from '#lib/site/transitDisplayContext.ts';
	import { liveReader } from '#lib/v1/adapter/index.ts';
	import { getV1Runtime } from '#lib/v1/runtime.ts';
	import { createLiveStore } from '#lib/v1/live/store.svelte.ts';
	import type { Manifest } from '#lib/v1/schemas/index.ts';
	import type { DateWindow } from '#lib/v1/history/window.ts';
	import AboutFigures from '../record/AboutFigures.svelte';
	import AboutLiveFigures from '../record/AboutLiveFigures.svelte';
	import RecordActionGroup from '../record/RecordActionGroup.svelte';
	import RecordAnswer from '../record/RecordAnswer.svelte';
	import RecordCard from '../record/RecordCard.svelte';
	import RecordPending from '../record/RecordPending.svelte';
	import ScreenTitle from '../record/ScreenTitle.svelte';
	import StateMark from '../record/StateMark.svelte';
	import { healthReason } from '../record/dataHealthText.ts';
	import { recordSectionLinks } from '../record/recordLinks.ts';
	import { recordStateFor } from '../record/recordStates.ts';
	import { choose, lastGoodNote, recordMessage, tally } from '../record/recordText.ts';
	import {
		alertDetailsAllowed,
		alertDetailsLimit,
		alertReadings,
		alertSections,
	} from './alertRecord.ts';
	import {
		alertEffect,
		liveAlertCards,
		liveAlertCut,
		recordAlertCards,
		recordAlertCut,
		type AlertCut,
	} from './alertCards.ts';
	import AlertList from './AlertList.svelte';

	let {
		data,
		locale,
		manifest,
	}: {
		data: {
			mode: 'live' | 'record';
			period: DateWindow | null;
			downloadPeriod: DateWindow | null;
			tracked: boolean;
			officialAlertsUrl?: string;
			city: string;
			timeZone?: string;
			cityName: string;
			operator?: string;
			sections: ReturnType<typeof loadAlertRecord>;
		};
		locale: Locale;
		manifest?: Manifest | null;
	} = $props();
	const t = (en: string, fr: string) => choose(locale, en, fr);
	const title = $derived(t('Service alerts', 'Avis de service'));
	const subtitle = $derived([data.operator, data.cityName].filter(Boolean).join(', '));
	const liveMode = $derived(data.mode === 'live');
	const display = transitDisplay();
	const section = (id: string) => data.sections.find(({ section }) => section === id)?.answer;
	const answer = $derived(section('answer'));
	const messages = $derived(section('messages'));
	const stamp: StampProps | undefined = $derived(
		data.period ? { kind: 'record', label: recordStamp(data.period, locale) } : undefined,
	);
	const share = $derived.by(() => {
		const url = new URL(page.shallow?.url.href ?? page.url.href);
		url.searchParams.set('provider', data.city);
		return new URL(
			frameHref(url, {
				mode: data.mode,
				period: data.period && { ...data.period, preset: null },
			}),
			url,
		);
	});
	const files = $derived.by(() => {
		if (!data.downloadPeriod) return [];
		const target = new URL(
			frameHref(share, { mode: 'record', period: { ...data.downloadPeriod, preset: null } }),
			share,
		);
		return Object.entries(alertSections)
			.filter(([key]) => key !== 'messages' || alertDetailsAllowed(data.downloadPeriod!))
			.map(([key, label]) => ({
				label: liveMode ? t(`Record: ${label.en}`, `Bilan : ${label.fr}`) : label[locale],
				href: recordSectionLinks(target, key).csv,
			}));
	});
	const live = untrack(() =>
		liveMode && data.tracked && manifest
			? createLiveStore(manifest, liveReader, { families: ['alerts', 'vehicles'] })
			: null,
	);
	onMount(() => {
		live?.start();
		return () => live?.stop();
	});
	const clock = getV1Runtime().clock;
	const health = $derived(live?.familyStates.alerts.health);
	const liveTime = $derived(live?.alerts?.feed_captured_utc);
	const pending = $derived(
		live && !health?.retained && ['idle', 'loading'].includes(live.familyStates.alerts.phase),
	);
	const current = $derived(
		health?.state === 'live' && health.retained && !health.isStale && !health.notice,
	);
	const liveCards = $derived(liveAlertCards(live?.alerts?.alerts ?? [], clock.serverNow));
	const liveStamp: StampProps = $derived({
		kind: 'live',
		label: liveStampAge(null, locale),
		updatedAt: liveTime ? new Date(liveTime) : undefined,
		agoLabel: (seconds) => liveStampAge(seconds, locale),
	});
	const scope = $derived(
		t(
			'The agency writes these messages. Their dates, lines and stops come from the feed.',
			'L’agence rédige ces avis. Leurs dates, lignes et arrêts proviennent du flux.',
		),
	);
	const labelCount = (count: number) =>
		`${tally(count, locale)} ${t(count === 1 ? 'alert' : 'alerts', 'avis')}`;
	const unavailable = $derived(t('Unavailable', 'Indisponible'));
	const noAlerts = $derived(t('No alerts in effect.', 'Aucun avis en vigueur.'));
	let lineLimit = $state(12);
	const paging = $derived(alertPaging(locale));

	function formatCitation(key: keyof typeof alertSections, result: EngineAnswer, lastGood?: true) {
		const evidence = result.evidence;
		return [
			`Transit · ${title}, ${data.cityName}. ${alertSections[key][locale]}. ${dateRange({ from: evidence.start_date, to: evidence.end_date }, locale)}.`,
			key === 'answer' && 'value' in result && result.state === 'measured'
				? alertReadings(result, locale)
						.map(({ label, reading }) => `${label}: ${reading}.`)
						.join(' ')
				: '',
			methodEvidence(evidence, locale),
			lastGood ? lastGoodNote[locale] : '',
			recordSectionLinks(share, key).share,
		]
			.filter(Boolean)
			.join(' ');
	}
</script>

{#snippet actions(result?: EngineResult<EngineAnswer>)}
	<RecordActionGroup {locale} href={share.href} {files}>
		{#snippet citation()}
			{#if liveMode}
				<p>
					Transit · {title}, {data.cityName}. {t('Live now', 'En direct')}. {liveTime ?? ''}
					{share.href}
				</p>
			{:else if result?.kind === 'answer'}
				<p>{formatCitation('answer', result.answer, result.lastGood)}</p>
			{/if}
		{/snippet}
	</RecordActionGroup>
{/snippet}

{#snippet evidenceFooter(evidence: RecordEvidence, count?: number | null)}
	<div
		class="flex w-full flex-wrap justify-between gap-2 border-t border-border pt-2 font-mono text-small text-muted-foreground"
	>
		{#if count != null}<span>{labelCount(count)}</span>{/if}
		<span>{methodEvidence(evidence, locale, true)}</span>
	</div>
{/snippet}

{#snippet cutRows(rows: AlertCut[], group: 'effect' | 'line')}
	{#if rows.length}
		{#if group === 'effect'}
			<dl class="effect-grid grid gap-3">
				{#each rows as row, index (index)}
					<div class="min-w-0 border-t border-border pt-2">
						<dt class="wrap-break-word text-small text-muted-foreground">
							{alertEffect(row.key, locale)}
						</dt>
						<dd class="text-subheading font-semibold tabular-nums">{@render cutValue(row)}</dd>
					</div>
				{/each}
			</dl>
		{:else}
			<dl class="line-grid grid gap-x-6 lg:grid-cols-2">
				{#each rows.slice(0, lineLimit) as row, index (index)}
					<div
						class="line-reading flex min-w-0 items-center justify-between gap-3 border-b border-border"
					>
						<dt class="min-w-0">
							{#if row.key}
								<a
									class="flex min-h-11 min-w-11 flex-wrap items-center gap-x-2 text-primary underline"
									href={localizeHref(`/lines/${encodeURIComponent(row.key)}`, locale, data.city)}
								>
									<span class="w-12"><RoutePlate code={display.line(row.key)} /></span>
									<span>{display.lineName(row.key).name}</span>
								</a>
							{:else}
								<StateMark state="unknown" {locale} />
							{/if}
						</dt>
						<dd class="shrink-0 text-right tabular-nums">{@render cutValue(row)}</dd>
					</div>
				{/each}
			</dl>
			{#if rows.length > 12}
				<ShowMore
					shown={Math.min(lineLimit, rows.length)}
					total={rows.length}
					pageSize={12}
					labels={paging}
					onMore={(count) => (lineLimit += count)}
				/>
			{/if}
		{/if}
	{:else}
		<p>
			{group === 'effect'
				? noAlerts
				: t(
						'No line-specific alerts in this view.',
						'Aucun avis propre à une ligne dans cette vue.',
					)}
		</p>
	{/if}
{/snippet}

{#snippet cutValue(row: AlertCut)}
	{#if row.value == null}<StateMark state={recordStateFor(row.state)} {locale} />
	{:else}{tally(row.value, locale)}{/if}
{/snippet}

{#snippet resultState(result: EngineResult<EngineAnswer>)}
	{#if result.kind === 'busy'}
		<RecordPending {locale} busy />
	{:else if result.kind === 'answer'}
		<StateMark
			state={recordStateFor('state' in result.answer ? result.answer.state : undefined)}
			{locale}
		/>
	{:else}
		<StateNotice presentation="frameless" title={recordMessage(result, locale) ?? unavailable} />
	{/if}
{/snippet}

{#snippet recordCut(group: 'effect' | 'line')}
	{@const promise = section(group)}
	<div id={group} class="scroll-mt-24">
		<RecordCard title={alertSections[group][locale]} {stamp}>
			{#await promise}
				{#key promise}<RecordPending {locale} answer={promise} />{/key}
			{:then result}
				{#if result?.kind === 'answer' && 'cells' in result.answer && (result.answer.cells.length || result.answer.state === 'measured')}
					{@render cutRows(recordAlertCut(result.answer, group), group)}
					{@render evidenceFooter(result.answer.evidence)}
					{#if result.lastGood}<p>{lastGoodNote[locale]}</p>{/if}
				{:else if result}
					{@render resultState(result)}
				{/if}
			{/await}
		</RecordCard>
	</div>
{/snippet}

{#snippet recordAbout(result: RecordMeasure)}
	{@const evidence = result.evidence}
	{@const missing = evidence.days_not_measured.map(
		(day) =>
			`${dateRange({ from: day, to: day }, locale)} · ${healthReason(evidence.days_not_measured_reasons?.[day], locale)}`,
	)}
	{@const untracked = (evidence.days_not_tracked ?? []).map((day) =>
		dateRange({ from: day, to: day }, locale),
	)}
	<div>
		<span id="day"></span><span id="hour"></span><span id="stop"></span><span id="cause"></span>
		<AboutFigures
			title={t('About these figures', 'À propos de ces chiffres')}
			fields={[
				{
					key: 'period',
					label: t('Period', 'Période'),
					text: dateRange({ from: evidence.start_date, to: evidence.end_date }, locale),
				},
				{
					key: 'counts',
					label: t('Counted', 'Ce qui est compté'),
					text: result.info?.[0]?.text?.[locale]?.counts ?? scope,
				},
				{
					key: 'coverage',
					label: t('Coverage', 'Couverture'),
					text: result.coverage_note?.[locale] ?? null,
				},
				{
					key: 'missing',
					label: t('Days not measured', 'Jours non mesurés'),
					text: missing.join(' · '),
				},
				{
					key: 'untracked',
					label: t('Days not tracked', 'Jours sans suivi'),
					text: untracked.join(' · '),
				},
				{
					key: 'versions',
					label: t('Versions', 'Versions'),
					text: methodEvidence(evidence, locale, true),
				},
				{
					key: 'source',
					label: t('Source', 'Source'),
					text: data.operator
						? t(
								`Service alerts published by ${data.operator}.`,
								`Avis de service publiés par ${data.operator}.`,
							)
						: null,
				},
			]}
			versionsLink={{
				href: localizeHref('/metrics', locale, data.city),
				label: t('How we measure', 'Comment nous mesurons'),
			}}
		/>
	</div>
{/snippet}

<Surface>
	<article class="grid min-w-0 grid-cols-1 gap-4">
		<div class="border-b border-border pb-3">
			<ScreenTitle {title} {subtitle} />
		</div>
		<div class="grid min-w-0 grid-cols-1 gap-4" data-slot="screen-content">
			{#if !data.tracked}
				<div data-slot="screen-state">
					<StateNotice
						title={t('Not tracked', 'Non suivi')}
						glyph="⊠"
						role="status"
						body={t(
							'Transit does not track service alerts for this network.',
							'Transit ne suit pas les avis de service de ce réseau.',
						)}
					>
						{#snippet action()}
							{#if data.officialAlertsUrl}
								<a
									class="inline-flex min-h-11 max-w-[calc(100cqi-2.5rem)] items-center text-primary underline"
									href={data.officialAlertsUrl}
								>
									{t('Check official service alerts', 'Consulter les avis officiels')}
								</a>
							{/if}
						{/snippet}</StateNotice
					>
				</div>
			{:else if liveMode}
				{#if current}
					<div id="alerts-window" data-slot="screen-answer">
						<RecordAnswer
							value={tally(liveCards.length, locale)}
							sentence={alertAnswerSentence(liveCards.length, locale, true)}
							{locale}
							time={liveStamp}
							{actions}
						>
							{#snippet meta()}
								<p>{t('Counted:', 'Ce qui est compté :')} {labelCount(liveCards.length)}</p>
								<p>{scope}</p>
							{/snippet}
						</RecordAnswer>
					</div>
					<div id="alerts-breakdown">
						<RecordCard title={alertSections.effect[locale]} stamp={liveStamp}>
							{@render cutRows(liveAlertCut(liveCards, 'effect'), 'effect')}
						</RecordCard>
					</div>
					<div id="alerts-log" class="scroll-mt-24">
						<RecordCard title={t('In effect now', 'En vigueur maintenant')} stamp={liveStamp}>
							<AlertList
								cards={liveCards}
								{locale}
								city={data.city}
								timeZone={data.timeZone}
								live
							/>
						</RecordCard>
					</div>
					<RecordCard title={alertSections.line[locale]} stamp={liveStamp}>
						{@render cutRows(liveAlertCut(liveCards, 'line'), 'line')}
					</RecordCard>
				{:else}
					<div data-slot="screen-state">
						{#if pending}<p role="status">
								{t('Loading live alerts…', 'Chargement des avis en direct…')}
							</p>
						{:else}<StateMark state="no_live_data" {locale} />{/if}
					</div>
				{/if}
				<AboutLiveFigures
					{locale}
					operator={data.operator}
					healthLink={localizeHref('/status', locale, data.city)}
					captureAge={live?.familyStates.vehicles.health.ageSeconds}
				/>
			{:else if answer}
				<div id="answer" data-slot="screen-answer" class="min-w-0 scroll-mt-24">
					{#await answer}
						<div data-slot="screen-state"><RecordPending {locale} {answer} /></div>
					{:then result}
						{#if result.kind === 'answer' && 'value' in result.answer && result.answer.state === 'measured' && result.answer.value.alerts != null}
							{@const count = result.answer.value.alerts}
							{#snippet recordActions()}{@render actions(result)}{/snippet}
							<RecordAnswer
								value={tally(count, locale)}
								sentence={alertAnswerSentence(count, locale, false)}
								{locale}
								time={stamp}
								evidence={{
									sample: labelCount(count),
									record: result.answer.evidence,
									lastGood: result.lastGood,
								}}
								actions={recordActions}
							>
								{#snippet meta()}<p>{scope}</p>{/snippet}
							</RecordAnswer>
						{:else}
							<div data-slot="screen-state">{@render resultState(result)}</div>
						{/if}
					{/await}
				</div>
				{@render recordCut('effect')}
				<div id="messages" class="min-w-0 scroll-mt-24">
					<RecordCard title={t('Archive for these dates', 'Archives pour ces dates')} {stamp}>
						{#if messages}
							{#await messages}
								{#key messages}<RecordPending {locale} answer={messages} />{/key}
							{:then result}
								{#if result.kind === 'answer' && 'value' in result.answer && result.answer.state === 'measured'}
									{#if result.answer.evidence.alert_messages?.length || result.answer.value.alerts === 0}
										{#key messages}
											<AlertList
												cards={recordAlertCards(result.answer.evidence.alert_messages)}
												{locale}
												city={data.city}
												timeZone={data.timeZone}
												live={false}
											/>
										{/key}
									{:else}
										<p>
											{t('Message text is unavailable.', 'Le texte des avis est indisponible.')}
										</p>
									{/if}
									{@render evidenceFooter(result.answer.evidence, result.answer.value.alerts)}
									{#if result.lastGood}<p>{lastGoodNote[locale]}</p>{/if}
								{:else}
									{@render resultState(result)}
								{/if}
							{/await}
						{:else}
							<p>{alertDetailsLimit[locale]}</p>
						{/if}
					</RecordCard>
				</div>
				{@render recordCut('line')}
				{#await answer then result}
					{#if result.kind === 'answer' && 'value' in result.answer}{@render recordAbout(
							result.answer,
						)}{/if}
				{/await}
			{:else}
				<p>
					{t(
						'Choose a period to see the record.',
						'Choisissez une période pour consulter le bilan.',
					)}
				</p>
			{/if}
		</div>
	</article>
</Surface>

<style>
	.effect-grid {
		grid-template-columns: repeat(auto-fit, minmax(min(100%, 8rem), 1fr));
	}

	.line-grid {
		container-type: inline-size;
	}

	@container (inline-size < 11rem) {
		.line-reading {
			display: block;
		}
	}
</style>
