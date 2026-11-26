<script lang="ts">
	import { goto } from '$app/navigation';
	import { tick } from 'svelte';
	import { SvelteMap, SvelteURLSearchParams } from 'svelte/reactivity';
	import { SegmentedChoice, Stamp } from '@yesid/ui/brand';
	import { Combobox } from '@yesid/ui/combobox';
	import { foldSearchText } from '#lib/search/normalize.ts';
	import { RangeMark } from '@yesid/ui/chart';
	import { Surface } from '@yesid/ui/layout';
	import type { DataTableColumn } from '@yesid/ui/table';
	import { localizeHref, type Locale } from '#lib/i18n/index.ts';
	import type { RankingsRecord } from '#lib/server/engine.ts';
	import type { loadRankingsRecord, RankingIdentities } from '#lib/server/rankingsRecord.ts';
	import { stopNameFallback } from '#lib/site/absence.ts';
	import { frameHref } from '#lib/site/frameState.ts';
	import { countedUnit, dateRange, recordStamp, scheduledClock } from '#lib/site/presenter.ts';
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
		rankingLead,
		rankingRange,
		rankingReference,
		rankingValue,
		rankingVerdict,
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
	let rankingControls: HTMLDivElement | undefined = $state();
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

	async function select(selection: RankingSelection) {
		if (
			selection.kind === kind &&
			selection.measure === measure &&
			selection.serviceClass === serviceClass
		)
			return;
		const focused = document.activeElement;
		const group = focused?.closest('[role="radiogroup"]');
		const label =
			group && rankingControls?.contains(group) ? group.getAttribute('aria-label') : null;
		await goto(rankingHref(selection, locale, url.searchParams), { reset: false });
		if (!label) return;
		// The class choices depend on the ranking answer that is still streaming.
		await record.answer;
		await tick();
		if (
			document.activeElement !== document.body ||
			kind !== selection.kind ||
			measure !== selection.measure ||
			serviceClass !== selection.serviceClass
		)
			return;
		const groups = rankingControls?.querySelectorAll('[role="radiogroup"]') ?? [];
		const next = [...groups].find((item) => item.getAttribute('aria-label') === label);
		next
			?.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]')
			?.focus({ preventScroll: true });
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
			const heads = identities.headsigns[id];
			const direction =
				heads?.[0] && heads?.[1] && heads[0] !== heads[1]
					? t(`${heads[1]} to ${heads[0]}`, `De ${heads[1]} à ${heads[0]}`)
					: undefined;
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

{#snippet classControl(data: RankingsRecord)}
	{@const classes = [...new Set(data.available_classes)]}
	{#if data.kind === 'line' && classes.length > 1}
		{@const label = t('Compare lines', 'Comparer les lignes')}
		{@const options = ['all', ...classes].map((key) => ({
			key,
			label: classText(key, locale, classes),
		}))}
		{@const current = serviceClass ?? data.class ?? 'all'}
		{@const pickClass = (next: string | null) => {
			// Clearing the field means every line again.
			const target = next ?? 'all';
			if (target !== current) void select({ kind, measure, serviceClass: target });
		}}
		<div class="grid min-w-0 gap-1 @max-[36rem]:hidden">
			<p>{label}</p>
			<SegmentedChoice {options} value={current} {label} onSelect={pickClass} />
		</div>
		<div class="grid w-full min-w-0 gap-1 @min-[36rem]:hidden">
			<p aria-hidden="true">{label}</p>
			<Combobox
				options={options.map(({ key, label }) => ({
					value: key,
					label,
					search: foldSearchText(label),
				}))}
				value={current}
				onValueChange={pickClass}
				{label}
				clearLabel={t('Show all lines', 'Afficher toutes les lignes')}
				emptyLabel={t('No matching choice', 'Aucun choix correspondant')}
				fold={foldSearchText}
			/>
		</div>
	{/if}
{/snippet}

{#snippet controls()}
	<div bind:this={rankingControls} class="flex min-w-0 flex-wrap gap-x-6 gap-y-3">
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
		<div class="grid min-w-0 gap-1 @max-[36rem]:hidden">
			<p>{t('By', 'Par')}</p>
			<SegmentedChoice
				options={byOptions}
				value={measure}
				label={t('By', 'Par')}
				onSelect={selectMeasure}
			/>
		</div>
		<div class="grid w-full min-w-0 gap-1 @min-[36rem]:hidden">
			<p aria-hidden="true">{t('By', 'Par')}</p>
			<Combobox
				options={byOptions.map(({ key, label }) => ({
					value: key,
					label,
					search: foldSearchText(label),
				}))}
				value={measure}
				onValueChange={(next) => {
					const choice = byOptions.find(({ key }) => key === next);
					if (choice) selectMeasure(choice.key);
				}}
				label={t('By', 'Par')}
				clearLabel={t('Clear', 'Effacer')}
				emptyLabel={t('No matching measure', 'Aucune mesure correspondante')}
				fold={foldSearchText}
			/>
		</div>
		{#await record.answer then result}
			{#if result?.kind === 'answer'}{@render classControl(result.answer)}{/if}
		{/await}
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
	{#if first && entry}
		<div class="grid min-w-0 gap-3">
			<p class="text-body">
				<span
					class="block font-heading text-title leading-none font-extrabold text-accent-text tabular-nums sm:mr-2 sm:inline"
					>{rankingValue(first.value, measure, locale)}</span
				>
				{rankingLead(data, first, measure, rankedCount(data), locale)}
				{#if entry.href}<a class="text-primary underline" href={entry.href}>{leader(entry)}</a
					>{:else}{leader(entry)}{/if}.
			</p>
			{#if stamp}<div><Stamp {...stamp} /></div>{/if}
			{@render actions()}
			{#if lastGood}<p class="text-small text-muted-foreground">{lastGoodNote[locale]}</p>{/if}
		</div>
	{:else}
		<RecordAnswer
			{locale}
			value={null}
			sentence={t(
				'No entries can be ranked on these dates.',
				'Aucune entrée ne peut être classée à ces dates.',
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
		return {
			...row,
			entry,
			detail: [row.detail, coverageText(entry, locale)].filter(Boolean).join(' · ') || undefined,
		};
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
	{#snippet value(row: Ranked)}{rankingValue(row.entry.value, measure, locale)}{/snippet}
	{#snippet counted(row: Ranked)}
		{#each rankingCountLines(row.entry, measure, locale) as reading (reading)}<span
				class="block font-sans text-small text-right">{reading}</span
			>{/each}
	{/snippet}
	{#snippet range(row: Ranked)}
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
			<div class="inline-grid min-w-0 max-w-full">
				<RangeMark
					low={lower}
					high={upper}
					value={row.entry.value}
					domain={range}
					reference={ref ?? undefined}
					label={`${t('Range:', 'Plage\u00a0:')} ${caption}`}
					{caption}
				/>
				{#if verdict}<span class="text-small text-muted-foreground">{verdict}</span>{/if}
			</div>
		{:else}<span class="sr-only">{t('Range unavailable', 'Plage indisponible')}</span>{/if}
	{/snippet}
	{@const columns = [
		{
			key: 'value',
			header: measure === reporting ? t('per 100 h', 'par 100 h') : measureLabel,
			numeric: true,
			cell: value,
		},
		{ key: 'counted', header: t('Counted', 'Ce qui est compté'), align: 'end', cell: counted },
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
			class="grid min-w-0 grid-cols-[3ch_minmax(0,1fr)] items-start gap-x-2 @max-[13rem]:grid-cols-1"
		>
			<span class="pt-2 font-mono text-small tabular-nums"
				><span class="sr-only">{t('Rank', 'Rang')} </span>{tally(row.entry.rank, locale)}</span
			>
			<RecordTableName {row} {plates} columnCount={columns.length + 1} />
		</div>
	{/snippet}
	<RecordCard
		title={measure === reporting ? title : `${title}, ${by}`}
		{stamp}
		interactive={rows.some((row) => row.href) || rows.length > 20}
	>
		<div id="ranking" class="grid min-w-0 grid-cols-1 gap-3">
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
					nameWidth="34%"
					{rows}
					{columns}
					value="value"
					pageSize={rows.length > 20 ? 20 : undefined}
					rowHeading={heading}
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
									'Le trait indique la plage où la valeur tomberait environ 95 fois sur 100 sur une autre période de même durée.',
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
				{ key: 'source', label: t('Source', 'Source'), text: operator ?? record.city },
			]}
		/>
	{/await}
{/snippet}

<div class="@container">
	<Surface class="@max-[13rem]:[--space-page-x:var(--space-card-gap)]">
		<RecordScreen>
			<RecordGroup
				><ScreenTitle
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
				/></RecordGroup
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
