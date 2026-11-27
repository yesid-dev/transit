<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { getContext, untrack } from 'svelte';
	import { SvelteMap, SvelteURLSearchParams } from 'svelte/reactivity';
	import { Combobox } from '@yesid/ui/combobox';
	import {
		frameSurfaceRailContext,
		type RegisterFrameSurfaceRail,
	} from '#lib/components/shell/frameSurfaceRail.ts';
	import { RangeMark } from '@yesid/ui/chart';
	import { ControlsRail, Surface } from '@yesid/ui/layout';
	import type { DataTableColumn } from '@yesid/ui/table';
	import { intl, localizeHref, type Locale } from '#lib/i18n/index.ts';
	import type { RankingsRecord } from '#lib/server/engine.ts';
	import type { loadRankingsRecord, RankingIdentities } from '#lib/server/rankingsRecord.ts';
	import { stopNameFallback } from '#lib/site/absence.ts';
	import { frameHref } from '#lib/site/frameState.ts';
	import {
		citationSource,
		countedUnit,
		dateRange,
		recordStamp,
		rowSentence,
		scheduledClock,
	} from '#lib/site/presenter.ts';
	import { stopDisplayName } from '#lib/site/transitDisplay.ts';
	import { transitDisplay } from '#lib/site/transitDisplayContext.ts';
	import AboutFigures from '../record/AboutFigures.svelte';
	import RecordActionGroup from '../record/RecordActionGroup.svelte';
	import CiteBlock from '../record/CiteBlock.svelte';
	import RecordAnswer from '../record/RecordAnswer.svelte';
	import RecordCard from '../record/RecordCard.svelte';
	import RecordDataTable, { type RecordTableRow } from '../record/RecordDataTable.svelte';
	import RecordEvidenceLine from '../record/RecordEvidenceLine.svelte';
	import RecordGroup from '../record/RecordGroup.svelte';
	import RecordPending from '../record/RecordPending.svelte';
	import RecordUnavailable from '../record/RecordUnavailable.svelte';
	import { pendingBlockSize, type RecordWaiting } from '../record/recordWaiting.ts';
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
		type RankingKind,
		type RankingMeasure,
		type RankingSelection,
	} from './rankingSelection.ts';
	import {
		classText,
		exclusionText,
		lineRankingFloor,
		measureMeaning,
		rankOptionLabels,
		rankedNoun,
		rankingCitation,
		rankingCountLines,
		rankingHeadlineEnd,
		rankingLead,
		rankingRange,
		rankingReference,
		rankingValue,
		rankingVerdict,
		rankingWay,
		sampleText,
		serviceClassDefinition,
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
		rankingMeasures[kind].map((key) => ({
			key,
			label: rankOptionLabels[key]?.[locale] ?? measures[key][locale],
		})),
	);
	const pinned = $derived.by(() => {
		const params = new SvelteURLSearchParams(url.searchParams);
		params.set('provider', record.city);
		const target = new URL(rankingHref(record.selection, locale, params), url);
		const period = record.period && { ...record.period, preset: null };
		return new URL(frameHref(target, { mode: 'record', period }), url);
	});
	const links = $derived(recordSectionLinks(pinned, 'ranking'));
	const register = getContext<RegisterFrameSurfaceRail | undefined>(frameSurfaceRailContext);
	$effect(() => untrack(() => register?.(controls)));
	const rowShape = $derived<RecordWaiting>({
		shape: 'rows',
		count: 20,
		lines: 2,
		lead: kind === 'stop' ? 'code' : kind === 'vehicle' ? 'none' : 'plate',
	});
	const rowHeight = $derived(pendingBlockSize(rowShape));
	const cardTitle = $derived(measure === reporting ? title : title + ', ' + by);
	const excludedTitle = $derived(t('Excluded, with the reason', 'Exclusions et motifs'));
	const aboutTitle = $derived(t('About these figures', 'À propos de ces chiffres'));
	type Result = Awaited<NonNullable<typeof record.answer>>;
	let referenceResult = $state<{
		query: NonNullable<typeof record.reference>;
		answer: Awaited<typeof record.reference>;
	}>();
	const settledReference = $derived(
		referenceResult?.query === record.reference ? referenceResult?.answer : undefined,
	);
	$effect(() => {
		const query = record.reference;
		let active = true;
		if (!query) return;
		const accept = (answer: Awaited<typeof query> | null) => {
			if (active) referenceResult = { query, answer };
		};
		void query.then(accept, () => accept(null));
		return () => {
			active = false;
		};
	});

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
		void select({ kind: next, measure: nextMeasure, serviceClass: null });
	}
	function selectMeasure(next: RankingMeasure) {
		void select({ kind, measure: next, serviceClass });
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
			const direction = display.directory.subtitle(id);
			return {
				id,
				label: line.name ?? line.label,
				plate: { code: line.number ?? id },
				href: entityHref(`/lines/${encodeURIComponent(id)}`),
				detail:
					[
						direction,
						(serviceClass ?? 'all') === 'all'
							? row.classes.map((key) => classText(key, locale, row.classes)).join(', ')
							: '',
					]
						.filter(Boolean)
						.join(' · ') || undefined,
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
		const sign = display.directory.headsign(
			row.line,
			row.direction == null || !row.line ? null : identities.headsigns[row.line]?.[row.direction],
		);
		const label = [clock, sign ? display.toward(sign, locale, false) : null]
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
		const noun =
			rankedNoun(data.kind, data.class, data.available_classes, locale, data.ranked_count) ??
			(data.ranked_count === 1 ? rowHeader : listLabel).toLocaleLowerCase(locale);
		return t(
			`${tally(data.ranked_count, locale)} ${noun} with enough to judge`,
			`${tally(data.ranked_count, locale)} ${noun} avec assez de données pour conclure`,
		);
	}
	function leader(entry: RecordTableRow) {
		const number = entry.plate?.code;
		if (!number) return entry.label;
		const line = t(`line ${number}`, `ligne ${number}`);
		if (kind === 'departure') return `${entry.label}, ${line}`;
		return kind === 'line' && display.lineName(entry.id).name
			? `${line} ${entry.label}`
			: entry.label;
	}
	function exclusions(data: RankingsRecord) {
		const groups = new SvelteMap<string, { count: number; label: string }>();
		for (const row of data.excluded)
			groups.set(row.reason, {
				count: (groups.get(row.reason)?.count ?? 0) + 1,
				label: row.reason_text[locale],
			});
		// "No live data: 4. Low coverage: 7." One short sentence for each reason.
		return [...groups.values()]
			.map(({ count, label }) => `${label}${t(': ', '\u00a0: ')}${tally(count, locale)}.`)
			.join(' ');
	}
	/** Excluded rows in the order riders read numbers: 1, 2, 4, 139, not 1, 139, 2. */
	function excludedRows(data: RankingsRecord, identities: RankingIdentities) {
		const compare = intl.collator(locale, { numeric: true, sensitivity: 'base' }).compare;
		const key = (row: RecordTableRow) => row.plate?.code ?? row.leadingCode?.text ?? row.label;
		return data.excluded
			.map((entry): Excluded => ({ ...name(entry, identities), entry }))
			.sort((a, b) => compare(key(a), key(b)) || compare(a.id, b.id));
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

{#snippet choice(
	label: string,
	options: readonly { key: string; label: string }[],
	value: string,
	selectValue: (key: string) => void,
)}
	<div class="grid min-w-0 gap-1">
		<p aria-hidden="true" class="text-small text-muted-foreground">{label}</p>
		<Combobox
			searchable={false}
			{label}
			{value}
			options={options.map(({ key, label }) => ({ value: key, label }))}
			onValueChange={(key) => {
				if (key) selectValue(key);
			}}
		/>
	</div>
{/snippet}

{#snippet controls()}
	<ControlsRail label={t('Ranking choices', 'Choix de classement')}>
		<div class="grid w-full min-w-0 gap-3">
			{@render choice(t('Rank', 'Classer'), kindOptions, kind, (key) =>
				selectKind(key as RankingKind),
			)}
			{@render choice(t('By', 'Par'), byOptions, measure, (key) =>
				selectMeasure(key as RankingMeasure),
			)}
			{#if kind === 'line'}
				{#await record.answer then result}
					{#if result?.kind === 'answer'}
						{@const data = result.answer}
						{@const classes = [...new Set(data.available_classes)]}
						{#if classes.length > 1}
							{@const options = ['all', ...classes].map((key) => ({
								key,
								label: classText(key, locale, classes),
							}))}
							{@render choice(
								t('Compare lines', 'Comparer les lignes'),
								options,
								serviceClass ?? data.class ?? 'all',
								(key) => select({ kind, measure, serviceClass: key }),
							)}
						{/if}
					{/if}
				{/await}
			{/if}
		</div>
	</ControlsRail>
{/snippet}

{#snippet missing(result: Result | null, shape: RecordWaiting, allowRetry = false)}
	{#if result?.kind === 'busy'}
		<RecordPending {locale} busy {shape} />
	{:else if result?.kind === 'unreachable' && allowRetry}
		<RecordUnavailable {locale} retry={result.retry} />
	{:else if result?.kind === 'answer' && result.answer.state === 'not_tracked'}
		<p>
			{t(
				'No entries can be ranked on these dates.',
				'Aucun élément ne peut être classé à ces dates.',
			)}
		</p>
	{:else if !result || result.kind === 'answer'}
		<StateMark state="not_measured" {locale} />
	{:else}
		<p>{recordConnection[result.kind][locale]}</p>
	{/if}
{/snippet}

{#snippet untrackedAnswer()}
	<RecordAnswer
		{locale}
		value={null}
		state="not_tracked"
		time={stamp}
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
	{@const way = first ? rankingWay(first, measure, locale) : null}
	{#snippet actions()}
		<RecordActionGroup {locale} href={links.share} files={[{ href: links.csv, label: listLabel }]}>
			{#snippet citation()}<CiteBlock
					{locale}
					text={rankingCitation(
						listLabel,
						measureLabel,
						operator ?? record.city,
						data,
						locale,
						links.share,
						lastGood,
						citationSource(operator ?? record.city, page.data.provider, locale),
					)}
				/>{/snippet}
		</RecordActionGroup>
	{/snippet}
	{#if first && entry}
		<RecordAnswer
			{locale}
			value={rankingValue(first.value, measure, locale)}
			sentence={rankingLead(data, first, measure, rankedCount(data), locale) +
				' ' +
				leader(entry) +
				rankingHeadlineEnd(way)}
			time={stamp}
			{actions}
			evidence={lastGood ? { sample: '', lastGood } : undefined}
		>
			{#snippet statement()}
				<p class="ranking-reading">
					<span
						class="font-heading text-title leading-none font-extrabold text-accent-text tabular-nums"
						>{rankingValue(first.value, measure, locale)}</span
					>
					<span>
						{rankingLead(data, first, measure, rankedCount(data), locale)}
						{#if entry.href}<a class="text-primary underline" href={entry.href}>{leader(entry)}</a
							>{:else}{leader(entry)}{/if}{rankingHeadlineEnd(way)}
					</span>
				</p>
			{/snippet}
		</RecordAnswer>
	{:else}
		<RecordAnswer
			{locale}
			value={null}
			sentence={t(
				'No entries can be ranked on these dates.',
				'Aucun élément ne peut être classé à ces dates.',
			)}
			state={resultState(data)}
			time={stamp}
			{actions}
		/>
	{/if}
{/snippet}

{#snippet tableCard(data: RankingsRecord, identities: RankingIdentities)}
	{@const rows = data.rows.map((entry): Ranked => {
		const row = name(entry, identities);
		const facts = [
			row.detail,
			rankingWay(entry, measure, locale),
			coverageText(entry, locale),
		].filter((fact): fact is string => !!fact);
		return { ...row, entry, detail: facts.join(' · ') || undefined };
	})}
	{@const plates = rows.some((row) => row.plate || row.leadingCode)}
	{@const bounded = rows.filter(
		({ entry }) => entry.range.lower != null && entry.range.upper != null,
	)}
	{@const ref = bounded.length
		? rankingReference(settledReference ?? null, data, measure, locale)
		: null}
	{@const wilson = bounded.some(({ entry }) => entry.range.method.endsWith('wilson_95'))}
	{@const scale = domain(data)}
	{#snippet value(row: Ranked)}<strong class="font-sans"
			>{rankingValue(row.entry.value, measure, locale)}</strong
		>{/snippet}
	{#snippet phoneValue(row: Ranked)}<span class="whitespace-nowrap"
			>{rankingValue(
				row.entry.value,
				measure,
				locale,
			)}{#if measure === reporting}&nbsp;/&nbsp;h{/if}</span
		>{/snippet}
	{#snippet rank(row: Ranked)}<span class="sr-only">{t('Rank', 'Rang')} </span>{tally(
			row.entry.rank,
			locale,
		)}{/snippet}
	{#snippet counted(row: Ranked)}
		{#each rankingCountLines(row.entry, measure, locale) as reading (reading)}<span
				class="block font-sans text-small text-right @min-[48rem]:whitespace-nowrap">{reading}</span
			>{/each}
	{/snippet}
	{#snippet range(row: Ranked, showVerdict = true)}
		{@const { lower, upper } = row.entry.range}
		{#if lower != null && upper != null}
			{@const caption = rankingRange(row.entry, measure, locale)}
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
			<div class="inline-grid min-w-0 max-w-full font-sans">
				<RangeMark
					low={lower}
					high={upper}
					value={row.entry.value}
					domain={range}
					reference={ref ?? undefined}
					label={`${t('Range:', 'Intervalle\u00a0:')} ${caption}`}
					{caption}
				/>
				{#if verdict}<span class={showVerdict ? 'text-small text-muted-foreground' : 'sr-only'}
						>{verdict}</span
					>{/if}
			</div>
		{:else}<span class="sr-only">{t('Range unavailable', 'Plage indisponible')}</span>{/if}
	{/snippet}
	{#snippet phoneRange(row: Ranked)}{@render range(row, false)}{/snippet}
	{@const columns = [
		{
			key: 'value',
			header: measure === reporting ? t('Times an hour', 'Par heure') : measureLabel,
			numeric: true,
			cell: value,
		},
		{
			key: 'counted',
			header: t('Counted', 'Ce qui est compté'),
			align: 'end',
			width: '1%',
			cell: counted,
		},
		...(bounded.length
			? [
					{
						key: 'range',
						header: ref
							? t(
									`Range, against the network (${rankingValue(ref.value, measure, locale)})`,
									`Plage, réseau (${rankingValue(ref.value, measure, locale)})`,
								)
							: t('Range', 'Plage'),
						cell: range,
					},
				]
			: []),
	] satisfies DataTableColumn<Ranked>[]}
	{#snippet heading(row: Ranked)}
		<div
			class="grid min-w-0 grid-cols-[3ch_minmax(0,1fr)] items-baseline gap-x-2 @max-[13rem]:grid-cols-1"
		>
			<span class="font-mono text-small tabular-nums">{@render rank(row)}</span>
			<RecordTableName {row} {plates} columnCount={columns.length + 1} plateOnName />
		</div>
	{/snippet}
	<div
		class="grid min-w-0 grid-cols-1 gap-3"
		data-sparse-ranking={rows.length > 0 && rows.length < 20 ? '' : undefined}
	>
		{#if rows.length}
			{#if bounded.length}<p class="text-small">
					{t(
						'Nearby positions may not really differ. When the ranges of two rows overlap, the gap between them can be chance.',
						'Deux rangs proches peuvent se valoir. Quand leurs plages se chevauchent, l’écart peut être dû au hasard.',
					)}
				</p>{/if}
			<RecordDataTable
				{locale}
				title={listLabel}
				{rowHeader}
				{rows}
				{columns}
				value="value"
				pageSize={rows.length > 20 ? 20 : undefined}
				rowHeading={heading}
				phone={{
					includeRailTier: true,
					before: rank,
					value: phoneValue,
					line: (row) => {
						const way = rankingWay(row.entry, measure, locale);
						const counts = rankingCountLines(row.entry, measure, locale);
						return rowSentence(way ? [way, counts[1] ?? counts[0]] : counts, locale);
					},
					below: phoneRange,
				}}
			/>
			{#if !bounded.length}<p class="text-small text-muted-foreground">
					{t(
						'No range is available for these ranks.',
						'Aucune plage n’est disponible pour ces rangs.',
					)}
				</p>{:else}<p class="text-small text-muted-foreground">
					{#if ref}{t(
							'The dashed tick is the network over the same dates.',
							'Le trait pointillé représente le réseau aux mêmes dates.',
						)}
					{/if}
					{wilson
						? t(
								'The line is the range in which the value would fall about 95 times in 100 for another equal period.',
								'Le trait indique l’intervalle où la valeur se situerait environ 95 fois sur 100 sur une autre période de même durée.',
							)
						: data.range_notes[bounded[0].entry.range.method]?.[locale]}
					{#if bounded.length < rows.length}{t(
							'A blank range means none is available for that rank.',
							'Une plage vide signifie qu’aucune n’est disponible pour ce rang.',
						)}{/if}
				</p>{/if}
		{:else}<StateMark state={resultState(data)} {locale} />{/if}
		{#if data.coverage_note}<p class="text-muted-foreground">{data.coverage_note[locale]}</p>{/if}
	</div>
{/snippet}

{#snippet excludedCard(data: RankingsRecord, identities: RankingIdentities)}
	{@const title = excludedTitle}
	{#if data.excluded.length}
		{#snippet reason(row: Excluded)}{exclusionText(row.entry, measure, locale)}{/snippet}
		<RecordCard {title} disclosure={{ id: 'excluded', description: exclusions(data) }}>
			<RecordDataTable
				{locale}
				{title}
				{rowHeader}
				rows={excludedRows(data, identities)}
				columns={[{ key: 'reason', header: t('Reason', 'Motif'), cell: reason }]}
				phone={{
					line: (row) =>
						rowSentence([row.detail, exclusionText(row.entry, measure, locale)], locale),
				}}
			/>
		</RecordCard>
	{:else}<RecordCard {title}
			><p>{t('No exclusions for this list.', 'Aucune exclusion pour cette liste.')}</p></RecordCard
		>{/if}
{/snippet}

{#snippet about(data: RankingsRecord)}
	{@const info = data.info[0]}
	{@const minimum = sampleText(info.ranking_minimum_sample ?? info.minimum_sample, measure, locale)}
	{@const result = settledReference ?? null}
	{@const reference = rankingReference(result, data, measure, locale)}
	<AboutFigures
		title={aboutTitle}
		class="lg:min-h-[27rem]"
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
						? coverageText(result.answer.evidence, locale) || null
						: null,
			},
			{
				key: 'means',
				label: measureLabel,
				text: measureMeaning(measure, info.text[locale].definition, locale),
			},
			{
				key: 'ordering',
				label: t('Rank order', 'Ordre du classement'),
				text: data.rows.some((row) => row.ranking_bound != null) ? cautiousRanking[locale] : null,
			},
			{
				key: 'class',
				label: data.class ? classText(data.class, locale, data.available_classes) : '',
				text:
					data.kind === 'line' && data.class ? serviceClassDefinition(data.class, locale) : null,
			},
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
				key: 'method',
				label: t('Method', 'Méthode'),
				text: null,
				link: { href: entityHref('/metrics'), label: t('How we measure', 'Comment on mesure') },
			},
			{
				key: 'error',
				label: t('Seen an error?', 'Vous avez vu une erreur?'),
				text: null,
				link: {
					href: entityHref('/metrics') + '#about-transit',
					label: t('About Transit', 'À propos de Transit'),
				},
			},
			{ key: 'source', label: t('Source', 'Source'), text: operator ?? record.city },
		]}
	/>
{/snippet}

<div class="@container">
	<Surface class="@max-[13rem]:[--space-page-x:var(--space-card-gap)]">
		<RecordScreen>
			<div data-slot="screen-content" class="min-w-0">
				<RecordGroup class="gap-(--space-card-gap)">
					<ScreenTitle
						{title}
						subtitle={[
							operator,
							kind === 'line' && serviceClass && serviceClass !== 'all'
								? classText(serviceClass, locale).toLocaleLowerCase(locale)
								: null,
							by,
						]
							.filter(Boolean)
							.join(', ')}
					/>
					<div data-slot="screen-answer" class="ranking-answer">
						{#if record.notTracked}
							{@render untrackedAnswer()}
						{:else if !record.answer}
							<RecordAnswer
								{locale}
								value={null}
								time={stamp}
								state="not_measured"
								sentence={t(
									'No entries can be ranked on these dates.',
									'Aucun élément ne peut être classé à ces dates.',
								)}
							/>
						{:else}
							{#await record.answer}
								<RecordPending {locale} shape="answer" answer={record.answer} />
							{:then result}
								{#if result.kind === 'answer'}
									{#if result.answer.state === 'not_tracked'}
										{@render untrackedAnswer()}
									{:else}
										{@render renderAnswer(result.answer, result.identities, result.lastGood)}
									{/if}
								{:else}
									{@render missing(result, 'answer', true)}
								{/if}
							{/await}
						{/if}
					</div>
					{#if !record.notTracked}
						<RecordCard title={cardTitle} {stamp} stampRule interactive>
							<div
								id="ranking"
								class="ranking-list"
								style:--ranking-rows-wide={rowHeight?.wide}
								style:--ranking-rows-phone={rowHeight?.phone}
							>
								{#await record.answer}
									<RecordPending {locale} shape={rowShape} answer={record.answer ?? undefined} />
								{:then result}
									{#if result?.kind === 'answer' && result.answer.state !== 'not_tracked'}
										{@render tableCard(result.answer, result.identities)}
									{:else}
										{@render missing(result, rowShape)}
									{/if}
								{/await}
							</div>
							{#snippet evidence()}
								{#await record.answer then result}
									{#if result?.kind === 'answer' && result.answer.state !== 'not_tracked'}
										<RecordEvidenceLine
											evidence={result.answer.evidence}
											sample={rankedCount(result.answer)}
											{locale}
										/>
									{/if}
								{/await}
							{/snippet}
						</RecordCard>
					{/if}
				</RecordGroup>
				{#if !record.notTracked}
					<RecordGroup class="gap-(--space-card-gap)">
						{#await record.answer}
							<RecordCard title={excludedTitle} reserve="line"
								><RecordPending {locale} shape="line" /></RecordCard
							>
						{:then result}
							{#if result?.kind === 'answer' && result.answer.state !== 'not_tracked'}
								{@render excludedCard(result.answer, result.identities)}
							{:else}
								<RecordCard title={excludedTitle}>{@render missing(result, 'line')}</RecordCard>
							{/if}
						{/await}
					</RecordGroup>
					<RecordGroup class="gap-(--space-card-gap)">
						{#await record.answer}
							<RecordCard title={aboutTitle}
								><RecordPending {locale} shape={{ shape: 'facts', count: 4 }} /></RecordCard
							>
						{:then result}
							{#if result?.kind === 'answer' && result.answer.state !== 'not_tracked'}
								{@render about(result.answer)}
							{:else}
								<AboutFigures
									title={aboutTitle}
									class="lg:min-h-[27rem]"
									fields={[
										{
											key: 'method',
											label: t('Method', 'Méthode'),
											text: null,
											link: {
												href: entityHref('/metrics'),
												label: t('How we measure', 'Comment on mesure'),
											},
										},
									]}
								/>
							{/if}
						{/await}
					</RecordGroup>
				{/if}
			</div>
		</RecordScreen>
	</Surface>
</div>

<style>
	.ranking-reading {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 0.25rem 0.75rem;
		margin: 0;
	}
	.ranking-answer {
		min-block-size: 6.75rem;
	}
	.ranking-list:not(:has([data-sparse-ranking])) {
		min-block-size: var(--ranking-rows-wide);
	}
	@media (width < 40rem) {
		.ranking-answer {
			min-block-size: 13.25rem;
		}
		.ranking-list {
			min-block-size: var(--ranking-rows-phone);
		}
	}
</style>
