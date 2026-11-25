<script lang="ts">
	import { goto } from '$app/navigation';
	import { SvelteMap, SvelteURLSearchParams } from 'svelte/reactivity';
	import { RoutePlate, SegmentedChoice } from '@yesid/ui/brand';
	import { RangeMark } from '@yesid/ui/chart';
	import { Combobox } from '@yesid/ui/combobox';
	import { Surface } from '@yesid/ui/layout';
	import type { DataTableColumn } from '@yesid/ui/table';
	import { foldSearchText } from '#lib/search/normalize.ts';
	import { localizeHref, type Locale } from '#lib/i18n/index.ts';
	import type { RankingsRecord } from '#lib/server/engine.ts';
	import type { loadRankingsRecord, RankingIdentities } from '#lib/server/rankingsRecord.ts';
	import { stopNameFallback } from '#lib/site/absence.ts';
	import { frameHref } from '#lib/site/frameState.ts';
	import {
		countedUnit,
		dateRange,
		methodEvidence,
		recordPercent,
		recordStamp,
		scheduledClock,
	} from '#lib/site/presenter.ts';
	import { stopDisplayName } from '#lib/site/transitDisplay.ts';
	import { transitDisplay } from '#lib/site/transitDisplayContext.ts';
	import AboutFigures from '../record/AboutFigures.svelte';
	import RecordActionGroup from '../record/RecordActionGroup.svelte';
	import RecordAnswer from '../record/RecordAnswer.svelte';
	import RecordCard from '../record/RecordCard.svelte';
	import RecordDataTable, { type RecordTableRow } from '../record/RecordDataTable.svelte';
	import RecordEvidenceLine from '../record/RecordEvidenceLine.svelte';
	import RecordGroup from '../record/RecordGroup.svelte';
	import RecordPending from '../record/RecordPending.svelte';
	import RecordScreen from '../record/RecordScreen.svelte';
	import RecordTableName from '../record/RecordTableName.svelte';
	import ScreenTitle from '../record/ScreenTitle.svelte';
	import StateMark from '../record/StateMark.svelte';
	import { departureHref } from '../record/departureIdentity.ts';
	import { recordSectionLinks } from '../record/recordLinks.ts';
	import { recordStateFor } from '../record/recordStates.ts';
	import {
		cautiousRanking,
		choose,
		coverageText,
		lastGoodNote,
		recordConnection,
		tally,
	} from '../record/recordText.ts';
	import {
		measures,
		rankingHref,
		rankingKinds,
		rankingLists,
		rankingMeasures,
		reporting,
		worseIsHigher,
		type RankingKind,
		type RankingSelection,
	} from './rankingSelection.ts';
	import {
		classText,
		exclusionText,
		lineRankingFloor,
		rankingCitation,
		rankingRange,
		rankingReference,
		rankingSample,
		rankingValue,
		rankingVerdict,
		sampleText,
	} from './rankingText.ts';

	let {
		record,
		locale,
		url,
		operator,
	}: {
		record: Awaited<ReturnType<typeof loadRankingsRecord>>;
		locale: Locale;
		url: URL;
		operator?: string;
	} = $props();
	const t = (en: string, fr: string) => choose(locale, en, fr);
	const display = transitDisplay();
	const { kind, measure, serviceClass } = $derived(record.selection);
	const title = $derived(rankingLists[kind].title[locale]);
	const measureLabel = $derived(measures[measure][locale]);
	const by = $derived(`${t('by', 'par')} ${measureLabel.toLocaleLowerCase(locale)}`);
	const listLabel = $derived(rankingLists[kind].label[locale]);
	const rowHeader = $derived(
		{
			line: t('Line', 'Ligne'),
			stop: t('Stop', 'Arrêt'),
			departure: t('Departure', 'Départ'),
			vehicle: t('Vehicle', 'Véhicule'),
		}[kind],
	);
	const stamp = $derived(
		record.period
			? { kind: 'record' as const, label: recordStamp(record.period, locale) }
			: undefined,
	);
	const kindOptions = $derived(
		rankingKinds.map((key) => ({ key, label: rankingLists[key].label[locale] })),
	);
	const byOptions = $derived(
		rankingMeasures[kind].map((key) => ({ key, label: measures[key][locale] })),
	);
	const pinned = $derived.by(() => {
		const params = new SvelteURLSearchParams(url.searchParams);
		params.set('provider', record.city);
		const target = new URL(rankingHref(record.selection, locale, params), url);
		const period = record.period && { ...record.period, preset: null };
		return new URL(frameHref(target, { mode: 'record', period }), url);
	});
	const links = $derived(recordSectionLinks(pinned, 'ranking'));

	function select(selection: RankingSelection) {
		if (
			selection.kind === kind &&
			selection.measure === measure &&
			selection.serviceClass === serviceClass
		)
			return;
		void goto(rankingHref(selection, locale, url.searchParams), { reset: false });
	}
	function selectKind(next: RankingKind) {
		const nextMeasure = rankingMeasures[next].includes(measure)
			? measure
			: rankingMeasures[next][0];
		select({ kind: next, measure: nextMeasure, serviceClass: null });
	}
	function selectMeasure(next: string | null) {
		const selected =
			rankingMeasures[kind].find((option) => option === next) ?? rankingMeasures[kind][0];
		select({ kind, measure: selected, serviceClass });
	}
	function entityHref(path: string) {
		return frameHref(new URL(localizeHref(path, locale, record.city), url), {
			mode: 'record',
			period: record.period,
		});
	}

	type Entry = RankingsRecord['rows'][number] | RankingsRecord['excluded'][number];
	type Ranked = RecordTableRow & { entry: RankingsRecord['rows'][number] };
	type Excluded = RecordTableRow & { entry: RankingsRecord['excluded'][number] };
	function name(row: Entry, identities: RankingIdentities): RecordTableRow {
		const id = row.id;
		if (kind === 'line') {
			const line = display.lineName(id);
			return {
				id,
				label: line.name ?? line.label,
				plate: { code: line.number ?? id },
				href: entityHref(`/lines/${encodeURIComponent(id)}`),
				detail:
					serviceClass === 'all'
						? row.classes.map((key) => classText(key, locale)).join(', ')
						: undefined,
			};
		}
		if (kind === 'stop') {
			const stop = Object.hasOwn(identities.stops, id) ? identities.stops[id] : null;
			return {
				id,
				label: stop ? stopDisplayName(stop.name) : stopNameFallback(id, locale),
				leadingCode: { text: stop?.code ?? id, outline: true },
				href: entityHref(`/stop/${encodeURIComponent(id)}`),
			};
		}
		if (kind === 'vehicle')
			return {
				id,
				label: t(`Vehicle ${id}`, `Véhicule ${id}`),
				href: entityHref(`/vehicle/${encodeURIComponent(id)}`),
			};
		const line = row.line ? display.lineName(row.line) : null;
		const clock = scheduledClock(row.departure, locale);
		const sign =
			row.direction == null || !row.line ? null : identities.headsigns[row.line]?.[row.direction];
		const label = [clock, sign ? t(`toward ${sign}`, `vers ${sign}`) : null]
			.filter(Boolean)
			.join(' ');
		const href =
			row.line && row.departure
				? departureHref(pinned, locale, record.city, row.line, row.direction ?? null, row.departure)
				: null;
		return {
			id,
			label: label || t('Departure time unknown', 'Heure de départ inconnue'),
			plate: line ? { code: line.number ?? row.line! } : undefined,
			detail: line?.name ?? undefined,
			href: href ?? (row.line ? entityHref(`/lines/${encodeURIComponent(row.line)}`) : undefined),
		};
	}
	function rankedCount(data: RankingsRecord) {
		const noun = (data.ranked_count === 1 ? rowHeader : listLabel).toLocaleLowerCase(locale);
		return t(
			`${tally(data.ranked_count, locale)} ${noun} with enough to judge`,
			`${tally(data.ranked_count, locale)} ${noun} avec assez de données pour conclure`,
		);
	}
	function answerSentence(data: RankingsRecord, entry: Ranked['entry']) {
		const higher = worseIsHigher(measure);
		const extreme =
			data.rows.length === data.ranked_count &&
			data.rows.every((row) => (higher ? row.value <= entry.value : row.value >= entry.value));
		const label =
			measure === reporting ? t('rate', 'taux') : measureLabel.toLocaleLowerCase(locale);
		const description = extreme
			? t(
					`is the ${higher ? 'highest' : 'lowest'} ${label}`,
					`est la valeur ${higher ? 'la plus élevée' : 'la plus faible'} pour ${label}`,
				)
			: t(`is the first-ranked ${label}`, `est la valeur en tête pour ${label}`);
		const unit =
			measure === reporting
				? t('times per 100 hours in service ', 'fois par 100 heures en service ')
				: '';
		return `${unit}${description} ${t('among', 'parmi')} ${rankedCount(data)}.`;
	}
	function exclusions(data: RankingsRecord) {
		const groups = new SvelteMap<string, { count: number; label: string }>();
		for (const row of data.excluded)
			groups.set(row.reason, {
				count: (groups.get(row.reason)?.count ?? 0) + 1,
				label: row.reason_text[locale],
			});
		return [...groups.values()]
			.map(({ count, label }) => `${tally(count, locale)} · ${label}`)
			.join(' · ');
	}
	function resultState(data: RankingsRecord) {
		const reasons = [...new Set(data.excluded.map(({ reason }) => reason))];
		const missing = data.evidence.days_measured.length ? 'unknown' : 'not_measured';
		return recordStateFor(data.state ?? (reasons.length === 1 ? reasons[0] : missing));
	}

	function domain(data: RankingsRecord): [number, number] {
		if (measure !== reporting && measure !== 'median_delay' && measure !== 'excess_wait_time')
			return [0, 1];
		let low = 0,
			high = 0;
		for (const row of data.rows) {
			low = Math.min(low, row.range.lower ?? row.value, row.value);
			high = Math.max(high, row.range.upper ?? row.value, row.value);
		}
		return [low, high === low ? high + 1 : high];
	}
</script>

{#snippet controls()}
	<div class="flex min-w-0 flex-wrap gap-x-6 gap-y-3">
		<div class="grid min-w-0 gap-1 @max-[13rem]:w-full">
			<p>{t('Rank', 'Classer')}</p>
			<SegmentedChoice
				variant="fit-row"
				options={kindOptions}
				value={kind}
				label={t('Rank', 'Classer')}
				onSelect={selectKind}
			/>
		</div>
		<div class="grid min-w-0 gap-1 @max-[13rem]:w-full">
			<p>{t('By', 'Par')}</p>
			{#if byOptions.length > 5}
				<Combobox
					class="w-72 max-w-full"
					options={byOptions.map(({ key, label }) => ({
						value: key,
						label,
						search: foldSearchText(label),
					}))}
					value={measure}
					onValueChange={selectMeasure}
					label={t('By', 'Par')}
					clearLabel={t('Reset measure', 'Réinitialiser la mesure')}
					emptyLabel={t('No matching measures', 'Aucune mesure correspondante')}
					fold={foldSearchText}
				/>
			{:else}
				<SegmentedChoice
					variant="fit-row"
					options={byOptions}
					value={measure}
					label={t('By', 'Par')}
					onSelect={selectMeasure}
				/>
			{/if}
		</div>
	</div>
{/snippet}

{#snippet untrackedAnswer()}
	<RecordAnswer
		{locale}
		value={null}
		state="not_tracked"
		sentence={t(
			'Vehicle reporting is not tracked for this network.',
			'Les signalements des véhicules ne sont pas suivis sur ce réseau.',
		)}
	/>
{/snippet}

{#snippet renderAnswer(
	data: RankingsRecord,
	identities: RankingIdentities,
	lastGood: true | undefined,
)}
	{@const first = data.rows[0]}
	{@const entry = first ? name(first, identities) : null}
	{#snippet actions()}
		<RecordActionGroup {locale} href={links.share} files={[{ href: links.csv, label: listLabel }]}>
			{#snippet citation()}<p>
					{rankingCitation(
						listLabel,
						measureLabel,
						record.city,
						data,
						locale,
						links.share,
						lastGood,
					)}
				</p>{/snippet}
		</RecordActionGroup>
	{/snippet}
	<RecordAnswer
		{locale}
		value={first ? rankingValue(first.value, measure, locale) : null}
		sentence={first
			? answerSentence(data, first)
			: t(
					'No entries can be ranked on these dates.',
					'Aucune entrée ne peut être classée à ces dates.',
				)}
		state={first ? undefined : resultState(data)}
		time={stamp}
	>
		{#snippet meta()}
			<div class="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
				{#if entry}<div class="flex flex-wrap items-center gap-x-2">
						{#if entry.plate}<RoutePlate code={entry.plate.code} />{/if}
						{#if entry.href}<a
								class="inline-flex min-h-11 min-w-11 items-center text-primary underline"
								href={entry.href}>{entry.label}</a
							>{:else}{entry.label}{/if}
					</div>{/if}
				{@render actions()}
			</div>
			{#if lastGood}<p>{lastGoodNote[locale]}</p>{/if}
		{/snippet}
	</RecordAnswer>
{/snippet}

{#snippet tableCard(data: RankingsRecord, identities: RankingIdentities)}
	{@const rows = data.rows.map((entry): Ranked => ({ ...name(entry, identities), entry }))}
	{@const plates = rows.some((row) => row.plate || row.leadingCode)}
	{@const classes = [
		...new Set(['all', ...data.available_classes, ...(serviceClass ? [serviceClass] : [])]),
	]}
	{@const scale = domain(data)}
	{#snippet value(row: Ranked)}{rankingValue(row.entry.value, measure, locale)}{/snippet}
	{#snippet counted(row: Ranked)}<span class="text-small"
			>{rankingSample(row.entry, measure, locale)}</span
		>{/snippet}
	{#snippet range(row: Ranked)}
		{@const { lower, upper } = row.entry.range}
		{#if lower != null && upper != null}
			{@const caption = rankingRange(row.entry, measure, locale)}
			{#snippet mark(ref: ReturnType<typeof rankingReference>)}
				{@const range = ref
					? ([Math.min(scale[0], ref.value), Math.max(scale[1], ref.value)] as const)
					: scale}
				{@const verdict = rankingVerdict(
					row.entry,
					ref,
					data.evidence.method_version,
					measure,
					locale,
				)}
				<div class="inline-grid min-w-0 max-w-full">
					<RangeMark
						low={lower}
						high={upper}
						value={row.entry.value}
						domain={range}
						reference={ref ?? undefined}
						label={`${t('Range', 'Intervalle')}: ${caption}`}
						{caption}
					/>
					{#if verdict}<span class="text-small text-muted-foreground">{verdict}</span>{/if}
				</div>
			{/snippet}
			{#await record.reference}{@render mark(null)}{:then ref}{@render mark(
					rankingReference(ref, data, measure, locale),
				)}{/await}
		{:else}<span class="text-small text-muted-foreground"
				>{t('Range unavailable', 'Intervalle indisponible')}</span
			>{/if}
	{/snippet}
	{@const columns = [
		{
			key: 'value',
			header: measure === reporting ? t('Per 100 h', 'Par 100 h') : measureLabel,
			numeric: true,
			cell: value,
		},
		{ key: 'counted', header: t('Counted', 'Ce qui est compté'), cell: counted },
		{ key: 'range', header: t('Range', 'Plage'), cell: range },
	] satisfies DataTableColumn<Ranked>[]}
	{#snippet heading(row: Ranked)}
		<div
			class="grid min-w-0 grid-cols-[3ch_minmax(0,1fr)] items-start gap-x-2 @max-[13rem]:grid-cols-1"
		>
			<span class="pt-2 font-mono text-small tabular-nums"
				><span class="sr-only">{t('Rank', 'Rang')} </span>{tally(row.entry.rank, locale)}</span
			>
			<RecordTableName {row} {plates} columnCount={columns.length + 1} />
		</div>
	{/snippet}
	<RecordCard
		title={`${title}, ${by}`}
		{stamp}
		interactive={rows.some((row) => row.href) || (kind === 'line' && classes.length > 1)}
	>
		<div id="ranking" class="grid min-w-0 grid-cols-1 gap-3">
			{#if kind === 'line' && classes.length > 1}
				{@const defaultClass = t('Default class', 'Classe par défaut')}
				{@const options = [
					{ key: 'default', label: defaultClass },
					...classes.map((key) => ({
						key,
						label: key === 'all' ? t('All classes', 'Toutes les classes') : classText(key, locale),
					})),
				]}
				<div class="grid w-72 min-w-0 max-w-full grid-cols-1 gap-1 justify-self-start">
					<p>{t('Service class', 'Classe de service')}</p>
					<Combobox
						options={options.map(({ key, label }) => ({
							value: key,
							label,
							search: foldSearchText(label),
						}))}
						value={serviceClass}
						placeholder={defaultClass}
						label={t('Service class', 'Classe de service')}
						clearLabel={t('Reset service class', 'Réinitialiser la classe de service')}
						emptyLabel={t('No matching classes', 'Aucune classe correspondante')}
						fold={foldSearchText}
						onValueChange={(next) =>
							select({ kind, measure, serviceClass: next === 'default' ? null : next })}
					/>
				</div>
			{/if}
			{#if rows.length}
				{#if rows.some(({ entry }) => entry.ranking_bound != null)}<p class="text-small">
						{cautiousRanking[locale]}
					</p>{/if}
				<RecordDataTable
					{locale}
					title={listLabel}
					{rowHeader}
					nameWidth="34%"
					{rows}
					{columns}
					value="value"
					pageSize={rows.length > 20 ? 20 : undefined}
					rowHeading={heading}
				/>
			{:else}<StateMark state={resultState(data)} {locale} />{/if}
			{#if data.coverage_note}<p class="text-muted-foreground">{data.coverage_note[locale]}</p>{/if}
		</div>
		{#snippet evidence()}<RecordEvidenceLine
				evidence={data.evidence}
				sample={rankedCount(data)}
				{locale}
			/>{/snippet}
	</RecordCard>
{/snippet}

{#snippet excludedCard(data: RankingsRecord, identities: RankingIdentities)}
	{@const title = t('Excluded, with the reason', 'Exclusions et motifs')}
	{#if data.excluded.length}
		{#snippet reason(row: Excluded)}{exclusionText(row.entry, measure, locale)}{/snippet}
		<RecordCard {title} disclosure={{ id: 'excluded', description: exclusions(data) }}>
			<RecordDataTable
				{locale}
				{title}
				{rowHeader}
				rows={data.excluded.map((entry): Excluded => ({ ...name(entry, identities), entry }))}
				columns={[{ key: 'reason', header: t('Reason', 'Motif'), cell: reason }]}
			/>
		</RecordCard>
	{:else}<RecordCard {title}
			><p>{t('No exclusions for this list.', 'Aucune exclusion pour cette liste.')}</p></RecordCard
		>{/if}
{/snippet}

{#snippet about(data: RankingsRecord)}
	{@const info = data.info[0]}
	{@const minimum = sampleText(info.ranking_minimum_sample ?? info.minimum_sample, measure, locale)}
	{#await record.reference then result}
		{@const reference = rankingReference(result, data, measure, locale)}
		<AboutFigures
			title={t('About these figures', 'À propos de ces chiffres')}
			fields={[
				{
					key: 'period',
					label: t('Period', 'Période'),
					text: dateRange({ from: data.evidence.start_date, to: data.evidence.end_date }, locale),
				},
				{
					key: 'counted',
					label: t('Counted', 'Ce qui est compté'),
					text: `${rankedCount(data)} · ${countedUnit(data.evidence.days_measured.length, 'day', locale)}`,
				},
				{
					key: 'observed',
					label: t('Observed', 'Ce qui est observé'),
					text:
						reference && result?.kind === 'answer' && 'value' in result.answer
							? coverageText(result.answer.evidence, locale, recordPercent) || null
							: null,
				},
				{ key: 'means', label: measureLabel, text: info.text[locale].definition },
				{
					key: 'minimum',
					label: t('Minimum', 'Minimum'),
					text: lineRankingFloor(measure, info.ranking_floors?.line, locale) ?? minimum,
				},
				{
					key: 'comparison',
					label: t('Reference', 'Repère'),
					text:
						reference?.label ??
						t(
							'A comparable reference is unavailable for these dates.',
							'Aucune référence comparable n’est disponible à ces dates.',
						),
				},
				{
					key: 'versions',
					label: t('Versions', 'Versions'),
					text: methodEvidence(data.evidence, locale, true),
				},
				{ key: 'source', label: t('Source', 'Source'), text: operator ?? record.city },
			]}
			versionsLink={{
				href: entityHref('/metrics'),
				label: t('How we measure', 'Comment on mesure'),
			}}
		/>
	{/await}
{/snippet}

<div class="@container">
	<Surface class="@max-[13rem]:[--space-page-x:var(--space-card-gap)]">
		<RecordScreen>
			<RecordGroup
				><ScreenTitle {title} subtitle={[operator, by].filter(Boolean).join(', ')} /></RecordGroup
			>
			<div data-slot="screen-content" class="min-w-0">
				<RecordGroup>
					<div data-slot="screen-answer">
						{#if record.notTracked}
							{@render untrackedAnswer()}
						{:else if !record.answer}
							<RecordAnswer
								{locale}
								value={null}
								state="not_measured"
								sentence={t(
									'No entries can be ranked on these dates.',
									'Aucune entrée ne peut être classée à ces dates.',
								)}
							/>
						{:else}
							{#await record.answer}
								<RecordPending {locale} answer={record.answer} />
							{:then result}
								{#if result.kind === 'answer'}
									{#if kind === 'vehicle' && result.answer.state === 'not_tracked'}
										{@render untrackedAnswer()}
									{:else}{@render renderAnswer(
											result.answer,
											result.identities,
											result.lastGood,
										)}{/if}
								{:else if result.kind === 'busy'}<RecordPending {locale} busy />
								{:else}<RecordAnswer
										{locale}
										value={null}
										sentence={recordConnection[result.kind][locale]}
									/>{/if}
							{/await}
						{/if}
					</div>
					{@render controls()}
					{#await record.answer then result}{#if result?.kind === 'answer' && !(kind === 'vehicle' && result.answer.state === 'not_tracked')}{@render tableCard(
								result.answer,
								result.identities,
							)}{/if}{/await}
				</RecordGroup>
				{#await record.answer then result}
					{#if result?.kind === 'answer' && !(kind === 'vehicle' && result.answer.state === 'not_tracked')}
						<RecordGroup>{@render excludedCard(result.answer, result.identities)}</RecordGroup>
						<RecordGroup>{@render about(result.answer)}</RecordGroup>
					{/if}
				{/await}
			</div>
		</RecordScreen>
	</Surface>
</div>
