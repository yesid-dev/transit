<script lang="ts">
	import { page } from '$app/state';
	import { RoutePlate, type StampProps } from '@yesid/ui/brand';
	import { StateNotice } from '@yesid/ui/feedback';
	import { Surface } from '@yesid/ui/layout';
	import { ShowMore } from '@yesid/ui/table';
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
		captureAge,
		dateRange,
		liveStampAge,
		methodEvidence,
		recordStamp,
	} from '#lib/site/presenter.ts';
	import { transitDisplay } from '#lib/site/transitDisplayContext.ts';
	import LiveCapture from '#lib/live/LiveCapture.svelte';
	import { feedState, type CaptureSnapshot } from '#lib/live/captureSnapshot.ts';
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
		sortAlertLineCut,
		unstatedEffect,
		type AlertCut,
	} from './alertCards.ts';
	import AlertList from './AlertList.svelte';

	let {
		data,
		locale,
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
			capture: Promise<CaptureSnapshot | null> | null;
			sections: ReturnType<typeof loadAlertRecord>;
		};
		locale: Locale;
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
	const scope = $derived(
		t(
			'The agency writes these messages. Transit keeps each one in full, with its dates, lines and stops.',
			'L’agence rédige ces avis. Transit conserve chacun en entier, avec ses dates, ses lignes et ses arrêts.',
		),
	);
	const labelCount = (count: number) =>
		`${tally(count, locale)} ${t(count === 1 ? 'alert' : 'alerts', 'avis')}`;
	const unavailable = $derived(t('Unavailable', 'Indisponible'));
	const noAlerts = $derived(t('No alerts in effect.', 'Aucun avis en vigueur.'));
	const linePageSize = 6;
	let lineLimit = $state(linePageSize);
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

{#snippet actions(result?: EngineResult<EngineAnswer>, liveTime?: string | null)}
	<RecordActionGroup {locale} href={share.href} {files}>
		{#snippet citation()}
			{#if liveMode}
				<p>
					Transit · {title}, {data.cityName}. {t('Live now', 'En direct')}. {liveTime ?? ''}
					{share.href}
				</p>
			{:else if result?.kind === 'answer'}
				<p>{formatCitation('answer', result.answer, result.lastGood)}</p>
				{#each data.sections.filter(({ section }) => section !== 'answer') as { section, answer } (section)}
					{#await answer then cut}
						{#if cut.kind === 'answer'}
							<p>{formatCitation(section, cut.answer, cut.lastGood)}</p>
						{/if}
					{/await}
				{/each}
			{/if}
		{/snippet}
	</RecordActionGroup>
{/snippet}

{#snippet evidenceFooter(evidence?: RecordEvidence, count?: number | null)}
	{#if evidence || count != null}
		<div
			class="flex w-full flex-wrap justify-between gap-2 font-mono text-small text-muted-foreground"
		>
			{#if count != null}<span>{labelCount(count)}</span>{/if}
			{#if evidence}<span>{methodEvidence(evidence, locale, true)}</span>{/if}
		</div>
	{/if}
{/snippet}

{#snippet cutRows(rows: AlertCut[], group: 'effect' | 'line')}
	{#if rows.length}
		{#if group === 'effect'}
			{#if rows.every((row) => row.key === unstatedEffect && row.value != null)}
				<div class="grid gap-1">
					<StateMark state="not_published" {locale} />
					<p>
						{t(
							'The agency does not publish the effect of its messages.',
							'L’agence ne publie pas l’effet de ses avis.',
						)}
					</p>
				</div>
			{:else}
				<dl class="effect-grid grid gap-3">
					{#each rows as row, index (index)}
						<div class="min-w-0">
							<dt class="wrap-break-word text-small text-muted-foreground">
								{alertEffect(row.key, locale)}
							</dt>
							<dd class="text-subheading font-semibold tabular-nums">{@render cutValue(row)}</dd>
						</div>
					{/each}
				</dl>
				{#if rows.some((row) => row.key !== unstatedEffect && row.value != null)}
					<p class="mt-3 text-small text-muted-foreground">
						{t(
							'Effects are the agency’s own categories, kept as published.',
							'Les effets sont les catégories de l’agence, telles que publiées.',
						)}
					</p>
				{/if}
			{/if}
		{:else}
			<dl class="line-grid grid gap-x-6 lg:grid-cols-2">
				{#each sortAlertLineCut(rows, locale, display.line).slice(0, lineLimit) as row, index (index)}
					<div class="line-reading flex min-w-0 items-center justify-between gap-3">
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
			{#if rows.length > linePageSize}
				<ShowMore
					shown={Math.min(lineLimit, rows.length)}
					total={rows.length}
					pageSize={linePageSize}
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
	{#snippet cutCard(result?: EngineResult<EngineAnswer>)}
		{@const reading =
			result?.kind === 'answer' &&
			'cells' in result.answer &&
			(result.answer.cells.length || result.answer.state === 'measured')
				? result.answer
				: null}
		{@const rows = reading ? recordAlertCut(reading, group) : []}
		<RecordCard
			title={alertSections[group][locale]}
			{stamp}
			interactive={group === 'line' &&
				(rows.length > linePageSize || rows.some(({ key }) => Boolean(key)))}
		>
			{#if reading}
				{@render cutRows(rows, group)}
				{@render evidenceFooter(reading.evidence, rows.length === 1 ? rows[0].value : undefined)}
				{#if result?.kind === 'answer' && result.lastGood}<p>{lastGoodNote[locale]}</p>{/if}
			{:else if result}
				{@render resultState(result)}
			{:else if promise}
				{#key promise}<RecordPending {locale} answer={promise} />{/key}
			{/if}
		</RecordCard>
	{/snippet}
	<div id={group} class="scroll-mt-24">
		{#await promise}{@render cutCard()}{:then result}{@render cutCard(result)}{/await}
	</div>
{/snippet}

{#snippet archiveCard(result?: EngineResult<EngineAnswer>)}
	{@const reading =
		result?.kind === 'answer' && 'value' in result.answer && result.answer.state === 'measured'
			? result.answer
			: null}
	<RecordCard
		title={t('Archive for these dates', 'Archives pour ces dates')}
		{stamp}
		interactive={Boolean(reading?.evidence.alert_messages?.length)}
	>
		{#if reading}
			{#if reading.evidence.alert_messages?.length || reading.value.alerts === 0}
				{#key messages}
					<AlertList
						cards={recordAlertCards(reading.evidence.alert_messages)}
						{locale}
						city={data.city}
						timeZone={data.timeZone}
						live={false}
					/>
				{/key}
			{:else}
				<p>{t('Message text is unavailable.', 'Le texte des avis est indisponible.')}</p>
			{/if}
			{@render evidenceFooter(reading.evidence, reading.value.alerts)}
			{#if result?.kind === 'answer' && result.lastGood}<p>{lastGoodNote[locale]}</p>{/if}
		{:else if result}
			{@render resultState(result)}
		{:else if messages}
			{#key messages}<RecordPending {locale} answer={messages} />{/key}
		{:else}
			<p>{alertDetailsLimit[locale]}</p>
		{/if}
	</RecordCard>
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
			interactive
			compact
			fields={[
				{
					key: 'period',
					label: t('Period', 'Période'),
					text: dateRange({ from: evidence.start_date, to: evidence.end_date }, locale),
				},
				{
					key: 'counts',
					label: t('Counted', 'Ce qui est compté'),
					text:
						result.info?.[0]?.text?.[locale]?.counts ??
						(result.value.alerts != null ? labelCount(result.value.alerts) : null),
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
				label: t('How we measure', 'Comment on mesure'),
			}}
		/>
	</div>
{/snippet}

<Surface>
	<article class="grid min-w-0 grid-cols-1 gap-4">
		<div class="pb-3">
			<ScreenTitle {title} {subtitle} />
		</div>
		<div class="grid min-w-0 grid-cols-1 gap-2 sm:gap-4" data-slot="screen-content">
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
			{:else if liveMode && data.capture}
				<LiveCapture city={data.city} capture={data.capture}>
					{#snippet pending()}
						<div data-slot="screen-state">
							<p role="status">{t('Loading live alerts…', 'Chargement des avis en direct…')}</p>
						</div>
					{/snippet}
					{#snippet children(snapshot, now)}
						{@const feeds = Object.values(snapshot?.feeds ?? {})}
						{@const alertFeed = feeds.find(({ family }) => family === 'alerts')}
						{@const age = captureAge(alertFeed?.captured_at ?? null, now, locale)}
						{#if snapshot?.alerts && alertFeed?.captured_at && feedState(alertFeed, now) === 'live'}
							{@const liveCards = liveAlertCards(snapshot.alerts, now)}
							{@const liveStamp = {
								kind: 'live' as const,
								label: liveStampAge(null, locale),
								updatedAt: new Date(alertFeed.captured_at),
								agoLabel: (seconds: number) => liveStampAge(seconds, locale),
							}}
							{#snippet liveActions()}{@render actions(undefined, alertFeed.captured_at)}{/snippet}
							<div id="alerts-window" data-slot="screen-answer">
								<RecordAnswer
									value={tally(liveCards.length, locale)}
									sentence={alertAnswerSentence(liveCards.length, locale, true)}
									{locale}
									time={liveStamp}
									actions={liveActions}
								>
									{#snippet meta()}
										<p>{t('Counted:', 'Ce qui est compté :')} {labelCount(liveCards.length)}</p>
										<p>
											{t('A count of alerts at this moment.', 'Un décompte des avis à ce moment.')}
										</p>
										<p>{scope}</p>
									{/snippet}
								</RecordAnswer>
							</div>
							<div id="alerts-breakdown">
								<RecordCard title={alertSections.effect[locale]} stamp={liveStamp}>
									{@render cutRows(liveAlertCut(liveCards, 'effect'), 'effect')}
									{@render evidenceFooter(undefined, liveCards.length)}
								</RecordCard>
							</div>
							<div id="alerts-log" class="scroll-mt-24">
								<RecordCard
									title={t('In effect now', 'En vigueur maintenant')}
									stamp={liveStamp}
									interactive={liveCards.length > 0}
								>
									<AlertList
										cards={liveCards}
										{locale}
										city={data.city}
										timeZone={data.timeZone}
										live
									/>
									{@render evidenceFooter(undefined, liveCards.length)}
								</RecordCard>
							</div>
							<RecordCard
								title={alertSections.line[locale]}
								stamp={liveStamp}
								interactive={liveCards.some(({ routes }) => routes.length > 0)}
							>
								{@render cutRows(liveAlertCut(liveCards, 'line'), 'line')}
								{@render evidenceFooter(
									undefined,
									liveCards.filter(({ routes }) => routes.length).length,
								)}
							</RecordCard>
						{:else}
							<div data-slot="screen-state"><StateMark state="no_live_data" {locale} /></div>
						{/if}
						<AboutLiveFigures
							{locale}
							interactive
							operator={data.operator}
							healthLink={localizeHref('/status', locale, data.city)}
							scope={t(
								'Alerts in effect at this moment, in the latest feed capture.',
								'Les avis en vigueur en ce moment, dans le dernier relevé du flux.',
							)}
							statusLabel={t('How an alert counts', 'Quand un avis compte')}
							definition={t(
								'An alert counts when this moment falls inside one of its published periods, or when the agency gives no period.',
								'Un avis compte quand ce moment se trouve dans une de ses périodes publiées, ou quand l’agence ne publie aucune période.',
							)}
							captureText={t(
								`Alerts: ${age ?? 'unavailable'}.`,
								`Avis : ${age ?? 'indisponibles'}.`,
							)}
						/>
					{/snippet}
				</LiveCapture>
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
					{#await messages}{@render archiveCard()}{:then result}{@render archiveCard(
							result,
						)}{/await}
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
