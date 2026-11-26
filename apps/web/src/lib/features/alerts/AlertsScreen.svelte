<script lang="ts">
	import { page } from '$app/state';
	import { RoutePlate, Stamp, type StampProps } from '@yesid/ui/brand';
	import { StateNotice } from '@yesid/ui/feedback';
	import { Surface } from '@yesid/ui/layout';
	import { DataTable, type DataTableColumn } from '@yesid/ui/table';
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
		alertsNotCollected,
		officialAlertsLabel,
		captureAge,
		citeDates,
		dateRange,
		tickingLiveStamp,
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
	import CiteBlock from '../record/CiteBlock.svelte';
	import RecordAnswer from '../record/RecordAnswer.svelte';
	import RecordCard from '../record/RecordCard.svelte';
	import RecordEvidenceLine from '../record/RecordEvidenceLine.svelte';
	import RecordGroup from '../record/RecordGroup.svelte';
	import RecordPending from '../record/RecordPending.svelte';
	import RecordScreen from '../record/RecordScreen.svelte';
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
		type AlertCard,
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
			/** The French form of the agency after "de", as the city declares it. */
			operatorOf?: string | null;
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
	const paging = $derived(alertPaging(locale));

	function formatCitation(key: keyof typeof alertSections, result: EngineAnswer, lastGood?: true) {
		const evidence = result.evidence;
		return [
			`Transit · ${title}, ${data.cityName}. ${alertSections[key][locale]}. ${citeDates({ from: evidence.start_date, to: evidence.end_date }, locale)}.`,
			key === 'answer' && 'value' in result && result.state === 'measured'
				? alertReadings(result, locale)
						.map(({ label, reading }) => `${label}${locale === 'fr' ? '\u00a0' : ''}: ${reading}.`)
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
	{#snippet figures()}
		{#each data.sections.filter(({ section }) => section !== 'answer') as { section, answer } (section)}
			{#await answer then cut}
				{#if cut.kind === 'answer'}
					<CiteBlock {locale} text={formatCitation(section, cut.answer, cut.lastGood)} />
				{/if}
			{/await}
		{/each}
	{/snippet}
	<RecordActionGroup
		{locale}
		href={share.href}
		{files}
		figures={!liveMode && result?.kind === 'answer' ? figures : undefined}
	>
		{#snippet citation()}
			{#if liveMode}
				<CiteBlock
					{locale}
					text={[
						`Transit · ${title}, ${data.cityName}.`,
						`${t('Live now', 'En direct')}.`,
						liveTime ?? '',
						share.href,
					]
						.filter(Boolean)
						.join(' ')}
				/>
			{:else if result?.kind === 'answer'}
				<CiteBlock {locale} text={formatCitation('answer', result.answer, result.lastGood)} />
			{/if}
		{/snippet}
	</RecordActionGroup>
{/snippet}

{#snippet evidenceFooter(evidence?: RecordEvidence, count?: number | null, note?: string)}
	{@const sample = count == null ? null : labelCount(count)}
	{#if evidence}
		<RecordEvidenceLine {evidence} {locale} {sample} {note} />
	{:else if sample}
		<RecordEvidenceLine versions="" {locale} {sample} {note} />
	{/if}
{/snippet}

{#snippet lineCell(row: AlertCut)}
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
				<dl class="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2 lg:grid-cols-4">
					{#each rows as row, index (index)}
						<div class="min-w-0">
							<dt class="wrap-break-word">{alertEffect(row.key, locale)}</dt>
							<dd
								class={row.value != null ? 'font-heading text-heading font-extrabold' : undefined}
							>
								{@render cutValue(row)}
							</dd>
						</div>
					{/each}
				</dl>
				{#if rows.some((row) => row.key !== unstatedEffect && row.value != null)}
					<p class="mt-2 text-small text-muted-foreground">
						{t(
							'Effects are the agency’s own categories, kept as published.',
							'Les effets sont les catégories de l’agence, telles que publiées.',
						)}
					</p>
				{/if}
			{/if}
		{:else}
			<DataTable
				caption={alertSections.line[locale]}
				columns={[
					{ key: 'line', header: t('Line', 'Ligne'), rowHeader: true, cell: lineCell },
					{ key: 'count', header: t('Alerts', 'Avis'), numeric: true, cell: cutValue },
				] satisfies readonly DataTableColumn<AlertCut>[]}
				rows={sortAlertLineCut(rows, locale, display.line)}
				key={(row, index) => (row.key ? `line:${row.key}` : `unknown:${index}`)}
				responsive={{ mode: 'rows', primary: 'line', value: 'count' }}
				pageSize={rows.length > linePageSize ? linePageSize : undefined}
				pageLabels={paging}
			/>
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
			expandable={group === 'line' && rows.length > 0}
			open={false}
			waiting={group === 'effect' && !result && promise ? 'card' : undefined}
		>
			{#if reading}
				{@render cutRows(rows, group)}
			{:else if result}
				{@render resultState(result)}
			{:else if promise}
				{#key promise}<RecordPending {locale} answer={promise} />{/key}
			{/if}
			{#snippet evidence()}
				{#if reading}
					{@render evidenceFooter(
						reading.evidence,
						rows.length === 1 ? rows[0].value : undefined,
						result?.kind === 'answer' && result.lastGood ? lastGoodNote[locale] : undefined,
					)}
				{/if}
			{/snippet}
		</RecordCard>
	{/snippet}
	<div id={group} class="scroll-mt-24">
		{#await promise}{@render cutCard()}{:then result}{@render cutCard(result)}{/await}
	</div>
{/snippet}

{#snippet logHeading(label: string, stamp?: StampProps)}
	<header class="flex min-w-0 flex-wrap items-center justify-between gap-2">
		<h2 class="text-subheading font-semibold">{label}</h2>
		{#if stamp}<Stamp {...stamp} />{/if}
	</header>
{/snippet}

{#snippet messageList(cards: AlertCard[], live: boolean)}
	<AlertList {cards} {locale} city={data.city} timeZone={data.timeZone} {live} />
{/snippet}

{#snippet archive(result?: EngineResult<EngineAnswer>)}
	{@const reading =
		result?.kind === 'answer' && 'value' in result.answer && result.answer.state === 'measured'
			? result.answer
			: null}
	{#if reading}
		{#if reading.evidence.alert_messages?.length || reading.value.alerts === 0}
			{#key messages}
				{@render messageList(recordAlertCards(reading.evidence.alert_messages), false)}
			{/key}
		{:else}
			<p>{t('Message text is unavailable.', 'Le texte des avis est indisponible.')}</p>
		{/if}
		{@render evidenceFooter(
			reading.evidence,
			reading.value.alerts,
			result?.kind === 'answer' && result.lastGood ? lastGoodNote[locale] : undefined,
		)}
	{:else if result}
		{@render resultState(result)}
	{:else if messages}
		{#key messages}<RecordPending shape="listing" {locale} answer={messages} />{/key}
	{:else}
		<p>{alertDetailsLimit[locale]}</p>
	{/if}
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
					key: 'method',
					label: t('Method', 'Méthode'),
					text: null,
					link: {
						href: localizeHref('/metrics', locale, data.city),
						label: t('How we measure', 'Comment on mesure'),
					},
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
		/>
	</div>
{/snippet}

<Surface>
	<RecordScreen>
		<RecordGroup>
			<ScreenTitle {title} {subtitle} />
		</RecordGroup>
		<div class="contents" data-slot="screen-content">
			{#if !data.tracked}
				<RecordGroup>
					<div data-slot="screen-state">
						<StateNotice
							title={t('Not tracked', 'Non suivi')}
							glyph="⊠"
							role="status"
							body={alertsNotCollected(
								{ name: data.operator ?? data.cityName, frenchOf: data.operatorOf },
								locale,
							)}
						>
							{#snippet action()}
								{#if data.officialAlertsUrl}
									<a
										class="inline-flex min-h-11 max-w-[calc(100cqi-2.5rem)] items-center text-primary underline"
										href={data.officialAlertsUrl}
									>
										{officialAlertsLabel(locale)}
									</a>
								{/if}
							{/snippet}</StateNotice
						>
					</div>
				</RecordGroup>
			{:else if liveMode && data.capture}
				<LiveCapture city={data.city} capture={data.capture}>
					{#snippet pending()}
						<RecordGroup waiting="answer">
							<div data-slot="screen-state">
								<p role="status">{t('Loading live alerts…', 'Chargement des avis en direct…')}</p>
							</div>
						</RecordGroup>
					{/snippet}
					{#snippet children(snapshot, now)}
						{@const feeds = Object.values(snapshot?.feeds ?? {})}
						{@const alertFeed = feeds.find(({ family }) => family === 'alerts')}
						{@const age = captureAge(alertFeed?.captured_at ?? null, now, locale)}
						{#if snapshot?.alerts && alertFeed?.captured_at && feedState(alertFeed, now) === 'live'}
							{@const liveCards = liveAlertCards(snapshot.alerts, now)}
							{@const lineCount = liveCards.filter(({ routes }) => routes.length).length}
							{@const liveStamp = tickingLiveStamp(new Date(alertFeed.captured_at), locale)}
							{#snippet liveActions()}{@render actions(undefined, alertFeed.captured_at)}{/snippet}
							<RecordGroup density="compact">
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
											<p>{scope}</p>
										{/snippet}
									</RecordAnswer>
								</div>
								<div id="alerts-breakdown">
									<RecordCard title={alertSections.effect[locale]} stamp={liveStamp}>
										{@render cutRows(liveAlertCut(liveCards, 'effect'), 'effect')}
										{#snippet evidence()}{@render evidenceFooter(
												undefined,
												liveCards.length,
											)}{/snippet}
									</RecordCard>
								</div>
							</RecordGroup>
							<RecordGroup id="alerts-log" class="scroll-mt-24" density="compact">
								{@render logHeading(t('In effect now', 'En vigueur maintenant'), liveStamp)}
								{@render messageList(liveCards, true)}
								{@render evidenceFooter(undefined, liveCards.length)}
							</RecordGroup>
							<RecordGroup density="compact">
								<RecordCard
									title={alertSections.line[locale]}
									stamp={liveStamp}
									expandable={lineCount > 0}
									open={false}
								>
									{@render cutRows(liveAlertCut(liveCards, 'line'), 'line')}
									{#snippet evidence()}
										{@render evidenceFooter(undefined, lineCount)}
									{/snippet}
								</RecordCard>
							</RecordGroup>
						{:else}
							<RecordGroup>
								<div data-slot="screen-state"><StateMark state="no_live_data" {locale} /></div>
							</RecordGroup>
						{/if}
						<RecordGroup density="compact">
							<AboutLiveFigures
								{locale}
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
						</RecordGroup>
					{/snippet}
				</LiveCapture>
			{:else if answer}
				<RecordGroup density="compact">
					<div id="answer" data-slot="screen-answer" class="min-w-0 scroll-mt-24">
						{#await answer}
							<div data-slot="screen-state"><RecordPending shape="answer" {locale} {answer} /></div>
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
				</RecordGroup>
				<RecordGroup id="messages" class="scroll-mt-24" density="compact">
					{@render logHeading(t('Archive for these dates', 'Archives pour ces dates'), stamp)}
					{#await messages}{@render archive()}{:then result}{@render archive(result)}{/await}
				</RecordGroup>
				<RecordGroup density="compact">
					{@render recordCut('line')}
				</RecordGroup>
				{#await answer then result}
					{#if result.kind === 'answer' && 'value' in result.answer}
						<RecordGroup density="compact">{@render recordAbout(result.answer)}</RecordGroup>
					{/if}
				{/await}
			{:else}
				<RecordGroup>
					<p data-slot="screen-state">
						{t(
							'Choose a period to see the record.',
							'Choisissez une période pour consulter le bilan.',
						)}
					</p>
				</RecordGroup>
			{/if}
		</div>
	</RecordScreen>
</Surface>
