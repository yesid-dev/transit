<script lang="ts">
	import type { Awaitable, Ready } from '#lib/site/ready.ts';
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
		countedNotice,
		dateRange,
		frenchAgency,
		tickingLiveStamp,
		methodEvidence,
		noPublishedNotices,
		noticeCount,
		noticeCountEvidence,
		noticeLineName,
		publishedAlertCount,
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
		groupAlertCards,
		type AlertCard,
		liveAlertCards,
		liveAlertCut,
		recordAlertCards,
		recordNoticeCards,
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
			capture: Awaitable<CaptureSnapshot | null> | null;
			sections: Ready<ReturnType<typeof loadAlertRecord>>;
		};
		locale: Locale;
	} = $props();
	const t = (en: string, fr: string) => choose(locale, en, fr);
	const title = $derived(t('Service alerts', 'Avis de service'));
	const subtitle = $derived([data.operator, data.cityName].filter(Boolean).join(', '));
	const operator = $derived({ name: data.operator ?? data.cityName, frenchOf: data.operatorOf });
	const effectNotPublished = $derived(
		t(
			'The agency does not publish the effect of its notices.',
			'La société de transport ne publie pas l’effet de ses avis.',
		),
	);
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
			'La société de transport rédige ces avis. Transit conserve chacun en entier, avec ses dates, ses lignes et ses arrêts.',
		),
	);
	const unavailable = $derived(t('Unavailable', 'Indisponible'));
	const noAlerts = $derived(t('No notices in effect.', 'Aucun avis en vigueur.'));
	const linePageSize = 6;
	const lineShape = { shape: 'rows', count: linePageSize, lines: 1 } as const;
	const noticesShape = { shape: 'notice', count: 5 } as const;
	const effectShape = { shape: 'facts', count: 2 } as const;
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

{#snippet actions(
	result?: EngineResult<EngineAnswer>,
	liveTime?: string | null,
	published?: number,
)}
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
						published == null ? '' : publishedAlertCount(published, locale) + '.',
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
	{@const sample = count == null ? null : noticeCount(count, locale)}
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
			<span>{noticeLineName(display.line(row.key), display.lineName(row.key).name)}</span>
		</a>
	{:else}
		<StateMark state="unknown" {locale} />
	{/if}
{/snippet}

{#snippet cutRows(rows: AlertCut[], group: 'effect' | 'line')}
	{#if rows.length}
		{#if group === 'effect'}
			<dl class="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2 lg:grid-cols-4">
				{#each rows as row, index (index)}
					<div class="min-w-0">
						<dt class="wrap-break-word">{alertEffect(row.key, locale)}</dt>
						<dd class={row.value != null ? 'font-heading text-heading font-extrabold' : undefined}>
							{@render cutValue(row)}
						</dd>
					</div>
				{/each}
			</dl>
			{#if rows.some((row) => row.key !== unstatedEffect && row.value != null)}
				<p class="mt-2 text-small text-muted-foreground">
					{t(
						'Effects are the agency’s own categories, kept as published.',
						'Les effets sont les catégories publiées par la société de transport.',
					)}
				</p>
			{/if}
		{:else}
			<DataTable
				caption={alertSections.line[locale]}
				columns={[
					{ key: 'line', header: t('Line', 'Ligne'), rowHeader: true, cell: lineCell },
					{
						key: 'count',
						header: t('Notices', 'Avis'),
						numeric: true,
						cell: cutValue,
					},
				] satisfies readonly DataTableColumn<AlertCut>[]}
				rows={sortAlertLineCut(rows, locale, display.line)}
				key={(row, index) => (row.key ? `line:${row.key}` : `unknown:${index}`)}
				responsive={{ mode: 'rows', primary: 'line', value: 'count', labels: false }}
				pageSize={rows.length > linePageSize ? linePageSize : undefined}
				pageLabels={paging}
			/>
		{/if}
	{:else}
		<p>
			{group === 'effect'
				? noAlerts
				: t(
						'No line-specific notices in this view.',
						'Aucun avis propre à une ligne dans cette vue.',
					)}
		</p>
	{/if}
{/snippet}

{#snippet recordEffects(promise: Awaitable<EngineResult<EngineAnswer>>)}
	<div id="effect" class="scroll-mt-24">
		<RecordCard title={alertSections.effect[locale]} {stamp} stampRule reserve={effectShape}>
			{#await promise}<RecordPending {locale} answer={promise} shape={effectShape} />
			{:then result}
				{#if result.kind === 'answer' && 'cells' in result.answer && result.answer.state === 'measured'}
					{@const rows = recordAlertCut(result.answer, 'effect')}
					{#if rows.some(({ key, value }) => key !== unstatedEffect && value != null)}{@render cutRows(
							rows,
							'effect',
						)}{:else}<p>{effectNotPublished}</p>{/if}
				{:else}{@render resultState(result, effectShape)}{/if}
			{/await}
		</RecordCard>
	</div>
{/snippet}

{#snippet cutValue(row: AlertCut)}
	{#if row.value == null}<StateMark state={recordStateFor(row.state)} {locale} />
	{:else}{tally(row.value, locale)}{/if}
{/snippet}

{#snippet resultState(
	result: EngineResult<EngineAnswer>,
	shape?: import('../record/recordWaiting.ts').RecordWaiting,
)}
	{#if result.kind === 'busy'}
		<RecordPending {locale} {shape} busy />
	{:else if result.kind === 'answer'}
		<StateMark
			state={recordStateFor('state' in result.answer ? result.answer.state : undefined)}
			{locale}
		/>
	{:else}
		<StateNotice presentation="frameless" title={recordMessage(result, locale) ?? unavailable} />
	{/if}
{/snippet}

{#snippet recordLines()}
	{@const promise = section('line')}
	{#snippet cutCard(result?: EngineResult<EngineAnswer>)}
		{@const reading =
			result?.kind === 'answer' &&
			'cells' in result.answer &&
			(result.answer.cells.length || result.answer.state === 'measured')
				? result.answer
				: null}
		{@const rows = reading ? recordAlertCut(reading, 'line') : []}
		<RecordCard
			interactive
			title={alertSections.line[locale]}
			{stamp}
			stampRule
			reserve={lineShape}
		>
			{#if reading}
				{@render cutRows(rows, 'line')}
			{:else if result}
				{@render resultState(result, lineShape)}
			{:else if promise}
				{#key promise}<RecordPending {locale} answer={promise} shape={lineShape} />{/key}
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
	<div id="line" class="scroll-mt-24">
		{#await promise}{@render cutCard()}{:then result}{@render cutCard(result)}{/await}
	</div>
{/snippet}

{#snippet logHeading(label: string, time?: StampProps)}
	<header class="flex min-w-0 flex-wrap items-center justify-between gap-2">
		<h2 class="text-subheading font-semibold">{label}</h2>
		{#if time}<Stamp {...time} />{/if}
	</header>
{/snippet}

{#snippet messageList(cards: AlertCard[], live: boolean)}
	<AlertList
		{cards}
		{locale}
		city={data.city}
		timeZone={data.timeZone}
		{live}
		pageSize={noticesShape.count}
	/>
{/snippet}

{#snippet archive(result?: EngineResult<EngineAnswer>)}
	{@const reading =
		result?.kind === 'answer' && 'value' in result.answer && result.answer.state === 'measured'
			? result.answer
			: null}
	{#if reading}
		{#if reading.value.alerts === 0}
			<p>
				{noPublishedNotices(
					operator,
					'network',
					locale,
					!reading.evidence.days_not_measured.length && !reading.evidence.days_not_tracked?.length,
				)}
			</p>
		{:else if reading.evidence.alert_messages?.length}
			{#key messages}
				{@render messageList(recordAlertCards(reading.evidence.alert_messages), false)}
			{/key}
		{:else}
			<p>{t('Message text is unavailable.', 'Le texte des avis est indisponible.')}</p>
		{/if}
		{@render evidenceFooter(
			reading.evidence,
			undefined,
			result?.kind === 'answer' && result.lastGood ? lastGoodNote[locale] : undefined,
		)}
	{:else if result}
		{@render resultState(result, noticesShape)}
	{:else if messages}
		{#key messages}<RecordPending shape={noticesShape} {locale} answer={messages} />{/key}
	{:else}
		<p>{alertDetailsLimit[locale]}</p>
	{/if}
{/snippet}

{#snippet recordAbout(reading?: RecordMeasure)}
	{@const evidence = reading?.evidence}
	{@const missing = (evidence?.days_not_measured ?? []).map(
		(day) =>
			`${dateRange({ from: day, to: day }, locale)} · ${healthReason(evidence?.days_not_measured_reasons?.[day], locale)}`,
	)}
	{@const untracked = (evidence?.days_not_tracked ?? []).map((day) =>
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
					text: data.period ? dateRange(data.period, locale) : null,
				},
				{
					key: 'counts',
					label: t('Counted', 'Ce qui est compté'),
					text: countedNotice[locale],
				},
				{
					key: 'coverage',
					label: t('Coverage', 'Couverture'),
					text: reading?.coverage_note?.[locale] ?? null,
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
					links: [
						{
							href: localizeHref('/metrics', locale, data.city),
							label: t('How we measure', 'Comment on mesure'),
						},
						{
							href: localizeHref('/metrics', locale, data.city) + '#about-transit',
							label: t('Seen an error?', 'Vous avez vu une erreur?'),
						},
					],
				},
				{
					key: 'source',
					label: t('Source', 'Source'),
					text: data.operator
						? t(
								`Notices published by ${data.operator}.`,
								`Avis publiés par ${frenchAgency(operator).subject}.`,
							)
						: null,
				},
			]}
		/>
	</div>
{/snippet}

{#snippet recordLead(result: EngineResult<EngineAnswer>, count: number, published: number)}
	{#snippet recordActions()}{@render actions(result)}{/snippet}
	<RecordAnswer
		value={tally(count, locale)}
		sentence={alertAnswerSentence(count, locale, false)}
		{locale}
		time={stamp}
		evidence={{
			sample: count === published ? '' : noticeCountEvidence(count, published, operator, locale),
			lastGood: result.kind === 'answer' && result.lastGood,
		}}
		actions={recordActions}
		fullWidthContext
	>
		{#snippet meta()}<p>{scope}</p>{/snippet}
	</RecordAnswer>
{/snippet}

{#snippet liveAbout(age: string | null)}
	<AboutLiveFigures
		{locale}
		operator={locale === 'fr' && data.operator ? frenchAgency(operator).subject : data.operator}
		healthLink={localizeHref('/status', locale, data.city)}
		errorLink={localizeHref('/metrics', locale, data.city) + '#about-transit'}
		scope={t(
			'Notices in effect at this moment, in the latest feed capture.',
			'Les avis en vigueur en ce moment, dans le dernier relevé du flux.',
		)}
		statusLabel={t('How a notice counts', 'Quand un avis compte')}
		definition={t(
			'A notice counts when this moment falls inside one of its published periods, or when the agency gives no period.',
			'Un avis compte quand ce moment se trouve dans une de ses périodes publiées, ou quand la société de transport ne publie aucune période.',
		)}
		captureText={t(`Notices: ${age ?? 'unavailable'}.`, `Avis\u00a0: ${age ?? 'indisponibles'}.`)}
	/>
{/snippet}

<Surface>
	<RecordScreen>
		{#if !data.tracked || (!answer && !data.capture)}<RecordGroup
				><ScreenTitle {title} {subtitle} /></RecordGroup
			>{/if}
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
						<RecordGroup density="compact"
							><ScreenTitle {title} {subtitle} />
							<div data-slot="screen-answer"><RecordPending {locale} shape="answer" /></div>
							<RecordCard
								title={alertSections.effect[locale]}
								stampRule
								stampPending
								reserve={effectShape}><RecordPending {locale} shape={effectShape} /></RecordCard
							><RecordCard
								title={t('In effect now', 'En vigueur maintenant')}
								stampRule
								stampPending
								reserve={noticesShape}><RecordPending {locale} shape={noticesShape} /></RecordCard
							><RecordCard
								title={alertSections.line[locale]}
								stampRule
								stampPending
								reserve={lineShape}><RecordPending {locale} shape={lineShape} /></RecordCard
							></RecordGroup
						>
						<RecordGroup density="compact">{@render liveAbout(null)}</RecordGroup>
					{/snippet}
					{#snippet children(snapshot, now)}
						{@const feeds = Object.values(snapshot?.feeds ?? {})}
						{@const alertFeed = feeds.find(({ family }) => family === 'alerts')}
						{@const age = captureAge(alertFeed?.captured_at ?? null, now, locale)}
						{@const alertReady = !!(
							snapshot?.alerts &&
							alertFeed?.captured_at &&
							feedState(alertFeed, now) === 'live'
						)}
						{@const liveCards = alertReady ? liveAlertCards(snapshot?.alerts ?? [], now) : []}
						{@const liveNotices = groupAlertCards(liveCards)}
						{@const missingEffect = Boolean(
							liveCards?.length && liveCards.every(({ effect }) => !effect),
						)}
						{#if alertReady && alertFeed?.captured_at}
							{@const lineCount = liveNotices.filter(({ routes }) => routes.length).length}
							{@const liveStamp = tickingLiveStamp(new Date(alertFeed.captured_at), locale)}
							{#snippet liveActions()}{@render actions(
									undefined,
									alertFeed.captured_at,
									liveCards.length,
								)}{/snippet}
							<RecordGroup density="compact">
								<ScreenTitle {title} {subtitle} />
								<div id="alerts-window" data-slot="screen-answer">
									<RecordAnswer
										value={tally(liveNotices.length, locale)}
										sentence={alertAnswerSentence(liveNotices.length, locale, true)}
										{locale}
										time={liveStamp}
										actions={liveActions}
									>
										{#snippet meta()}
											<p>
												{t('Counted:', 'Ce qui est compté\u00a0:')}
												{noticeCountEvidence(
													liveNotices.length,
													liveCards.length,
													operator,
													locale,
												)}
											</p>
											<p>{scope}</p>
										{/snippet}
									</RecordAnswer>
								</div>
								<div id="alerts-breakdown">
									<RecordCard
										title={alertSections.effect[locale]}
										stamp={liveStamp}
										stampRule
										reserve={effectShape}
									>
										{#if missingEffect}<p>{effectNotPublished}</p>{:else}{@render cutRows(
												liveAlertCut(liveNotices, 'effect'),
												'effect',
											)}{/if}
									</RecordCard>
								</div>
							</RecordGroup>
							<RecordGroup density="compact">
								<section id="alerts-log" class="grid min-w-0 gap-(--space-card-gap) scroll-mt-24">
									{@render logHeading(t('In effect now', 'En vigueur maintenant'), liveStamp)}
									{@render messageList(liveCards, true)}
								</section>
								<RecordCard
									interactive
									title={alertSections.line[locale]}
									stamp={liveStamp}
									stampRule
									reserve={lineShape}
								>
									{@render cutRows(liveAlertCut(liveNotices, 'line'), 'line')}
									{#snippet evidence()}
										<RecordEvidenceLine
											versions=""
											{locale}
											sample={noticeCount(lineCount, locale)}
										/>
									{/snippet}
								</RecordCard>
							</RecordGroup>
						{:else}
							<RecordGroup>
								<ScreenTitle {title} {subtitle} />
								<div data-slot="screen-state"><StateMark state="no_live_data" {locale} /></div>
							</RecordGroup>
						{/if}
						<RecordGroup density="compact">
							{@render liveAbout(age)}
						</RecordGroup>
					{/snippet}
				</LiveCapture>
			{:else if answer}
				{@const effect = section('effect')}
				<RecordGroup density="compact">
					<ScreenTitle {title} {subtitle} />
					<div id="answer" data-slot="screen-answer" class="min-w-0 scroll-mt-24">
						{#await answer}
							<div data-slot="screen-state">
								<RecordPending shape="answer" {locale} {answer} fullWidthContext />
							</div>
						{:then result}
							{#if result.kind === 'answer' && 'value' in result.answer && result.answer.state === 'measured' && result.answer.value.alerts != null}
								{@const count = result.answer.value.alerts}
								{@const published = result.answer.value.alert_versions ?? count}
								{#await messages}
									{@render recordLead(result, count, published)}
								{:then detail}
									{@const reading =
										detail?.kind === 'answer' &&
										'value' in detail.answer &&
										detail.answer.state === 'measured'
											? detail.answer
											: null}
									{@render recordLead(
										result,
										(reading && recordNoticeCards(reading)?.length) ?? count,
										reading?.value.alert_versions ?? published,
									)}
								{/await}
							{:else}
								<div data-slot="screen-state">{@render resultState(result)}</div>
							{/if}
						{/await}
					</div>
					{#if effect}{@render recordEffects(effect)}{/if}
				</RecordGroup>
				<RecordGroup density="compact">
					<section id="messages" class="grid min-w-0 gap-(--space-card-gap) scroll-mt-24">
						{@render logHeading(t('Archive for these dates', 'Archives pour ces dates'), stamp)}
						{#await messages}{@render archive()}{:then result}{@render archive(result)}{/await}
					</section>
					{@render recordLines()}
				</RecordGroup>
				<RecordGroup density="compact"
					>{#await answer}{@render recordAbout()}{:then result}{@render recordAbout(
							result.kind === 'answer' && 'value' in result.answer ? result.answer : undefined,
						)}{/await}</RecordGroup
				>
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
