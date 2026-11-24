<script lang="ts">
	import { dateRange, scheduledClock } from '#lib/site/presenter.ts';
	import { goto } from '$app/navigation';
	import { FilterSummary, SegmentedChoice } from '@yesid/ui/brand';
	import { StateNotice } from '@yesid/ui/feedback';
	import RecordLineLabel from '../record/RecordLineLabel.svelte';
	import { Button } from '@yesid/ui/button';
	import { Card } from '@yesid/ui/card';
	import { Surface } from '@yesid/ui/layout';
	import { localizeHref, type Locale } from '#lib/i18n/index.ts';
	import type { RankingsRecord } from '#lib/server/engine.ts';
	import type { loadRankingsRecord } from '#lib/server/rankingsRecord.ts';
	import { frameHref } from '#lib/site/frameState.ts';
	import { transitDisplay } from '#lib/site/transitDisplayContext.ts';
	import { departureHref } from '../record/departureIdentity.ts';
	import RecordActions from '../record/RecordActions.svelte';
	import RecordPending from '../record/RecordPending.svelte';
	import { recordSectionLinks } from '../record/recordLinks.ts';
	import {
		cautiousRanking,
		choose,
		lastGoodNote,
		pooledDays,
		punctualityWeighting,
		recordMessage,
		tally,
		timingBasis,
	} from '../record/recordText.ts';
	import {
		measures,
		rankingKinds,
		rankingLists,
		rankingMeasures,
		type RankingKind,
		type RankingMeasure,
		type RankingPath,
	} from './rankingSelection.ts';
	import {
		classText,
		exclusionText,
		rankingCitation,
		lineRankingFloor,
		waitingRankingBasis,
		rankingRange,
		rankingRangeLabel,
		rankingSample,
		rankingValue,
		sampleText,
	} from './rankingText.ts';

	let {
		record,
		locale,
		origin,
		path,
	}: {
		record: Awaited<ReturnType<typeof loadRankingsRecord>>;
		locale: Locale;
		origin: string;
		path: RankingPath;
	} = $props();

	const t = (en: string, fr: string) => choose(locale, en, fr);
	const display = transitDisplay();
	const title = $derived(
		path === '/hotspots' ? t('Hotspots', 'Points chauds') : t('Repeat offenders', 'Récidivistes'),
	);
	const { kind, measure, serviceClass } = $derived(record.selection);
	const measureLabel = $derived(measures[measure][locale]);
	const listLabel = $derived(rankingLists[kind].label[locale]);
	const kindOptions = $derived(
		rankingKinds.map((key) => ({ key, label: rankingLists[key].label[locale] })),
	);
	const measureOptions = $derived(
		rankingMeasures[kind].map((key) => ({ key, label: measures[key][locale] })),
	);
	let limit = $state(12);
	$effect(() => {
		void record.answer;
		limit = 12;
	});

	function selectionUrl(
		nextKind: RankingKind,
		nextMeasure: RankingMeasure,
		nextClass: string | null,
	) {
		const next = new URL(localizeHref(rankingLists[nextKind].path, locale, record.city), origin);
		next.searchParams.set('kind', nextKind);
		next.searchParams.set('measure', nextMeasure);
		if (nextClass) next.searchParams.set('class', nextClass);
		return next;
	}

	function select(nextKind: RankingKind, nextMeasure: RankingMeasure, nextClass: string | null) {
		void goto(
			frameHref(selectionUrl(nextKind, nextMeasure, nextClass), {
				mode: 'record',
				period: record.period,
			}),
		);
	}

	const pinned = $derived.by(() => {
		const period = record.period && { ...record.period, preset: null };
		return new URL(
			frameHref(selectionUrl(kind, measure, serviceClass), { mode: 'record', period }),
			origin,
		);
	});
	const links = $derived(recordSectionLinks(pinned, 'ranking'));

	type Entry = RankingsRecord['rows'][number] | RankingsRecord['excluded'][number];
	function identity(row: Entry) {
		if (kind === 'line') return display.lineName(row.id).label;
		if (kind === 'stop') return t(`Stop ${row.id}`, `Arrêt ${row.id}`);
		if (kind === 'vehicle') return t(`Vehicle ${row.id}`, `Véhicule ${row.id}`);
		const line = row.line ? display.lineName(row.line).label : t('Unknown line', 'Ligne inconnue');
		const departure = scheduledClock(row.departure, locale);
		const direction = display.directionLabel(
			row.direction,
			record.headsigns[row.line ?? ''] ?? {},
			locale,
		);
		return `${line} · ${departure} · ${direction}`;
	}

	function entityHref(row: Entry) {
		if (kind === 'departure' && row.line && row.departure) {
			const href = departureHref(
				pinned,
				locale,
				record.city,
				row.line,
				row.direction ?? null,
				row.departure,
			);
			if (href) return href;
		}
		const entity =
			kind === 'stop'
				? '/stop/' + encodeURIComponent(row.id)
				: kind === 'line' || (kind === 'departure' && row.line)
					? '/lines/' + encodeURIComponent(row.line ?? row.id)
					: null;
		if (!entity) return null;
		const target = new URL(localizeHref(entity, locale, record.city), origin);
		return frameHref(target, { mode: 'record', period: record.period });
	}
</script>

{#snippet entity(row: Entry)}
	{@const href = entityHref(row)}
	{#snippet name()}
		{#if kind === 'line'}
			{@const line = display.lineName(row.id)}
			<RecordLineLabel label={line.label} code={line.number} />
		{:else}
			{identity(row)}
		{/if}
	{/snippet}
	{#if href}<a class="inline-flex min-h-11 flex-wrap items-center gap-x-1" {href}
			>{@render name()}</a
		>{:else}{@render name()}{/if}
{/snippet}

<Surface>
	<div class="grid min-w-0 grid-cols-1 gap-4">
		<header class="grid gap-2">
			<h1>{title}</h1>
			{#if record.period}<p>{dateRange(record.period, locale)}</p>{/if}
		</header>
		<div class="flex flex-wrap gap-x-8 gap-y-3">
			<div class="grid min-w-0 gap-1">
				<p>{t('Rank', 'Classer')}</p>
				<SegmentedChoice
					options={kindOptions}
					value={kind}
					label={t('Rank', 'Classer')}
					onSelect={(key) =>
						select(
							key,
							rankingMeasures[key].includes(measure) ? measure : rankingMeasures[key][0],
							null,
						)}
				/>
			</div>
			<label class="grid min-w-0 max-w-full grid-cols-1 gap-1">
				{t('Measure', 'Mesure')}
				<select
					class="labelled-input min-h-11 max-w-full"
					value={measure}
					onchange={(event) =>
						select(kind, event.currentTarget.value as RankingMeasure, serviceClass)}
				>
					{#each measureOptions as option (option.key)}
						<option value={option.key}>{option.label}</option>
					{/each}
				</select>
			</label>
		</div>
		<Card edge="neutral" textSize="inherit" class="min-w-0 px-4 sm:px-6">
			<section id="ranking" aria-labelledby="ranking-title" class="grid min-w-0 gap-3">
				<h2 id="ranking-title">{listLabel}</h2>
				{#if !record.answer}
					<StateNotice
						presentation="frameless"
						title={t('Not measured on those dates', 'Non mesuré à ces dates')}
					/>
				{:else}
					{#await record.answer}
						{#key record.answer}<RecordPending {locale} answer={record.answer} />{/key}
					{:then result}
						{@const message = recordMessage(result, locale)}
						{#if message}<StateNotice presentation="frameless" title={message} />{/if}
						{#if result.kind === 'answer'}
							{@const data = result.answer}
							{@const shown = data.rows.slice(0, limit)}
							{@const info = data.info[0]}
							{@const minimum = sampleText(
								info.ranking_minimum_sample ?? info.minimum_sample,
								measure,
								locale,
							)}
							{#if result.lastGood}<p>{lastGoodNote[locale]}</p>{/if}
							{#if kind === 'line'}
								{@const classes = [
									...new Set([
										...data.available_classes,
										...(serviceClass && serviceClass !== 'all' ? [serviceClass] : []),
									]),
								]}
								<label class="grid min-w-0 max-w-full grid-cols-1 gap-1 justify-self-start">
									{t('Service class', 'Classe de service')}
									<select
										class="labelled-input min-h-11 max-w-full"
										value={serviceClass ?? ''}
										onchange={(event) => select(kind, measure, event.currentTarget.value || null)}
									>
										<option value="">
											{t('Default class', 'Classe par défaut')}{data.class && !serviceClass
												? ` · ${classText(data.class, locale)}`
												: ''}
										</option>
										<option value="all">{t('All classes', 'Toutes les classes')}</option>
										{#each classes as key (key)}<option value={key}>{classText(key, locale)}</option
											>{/each}
									</select>
								</label>
							{/if}
							<p>{info.text[locale].definition}</p>
							{#if ['on_time', 'late', 'early', 'median_delay'].includes(measure)}<p>
									{punctualityWeighting[locale]}
								</p>{/if}
							{#if measure !== 'excess_wait_time' && data.evidence.start_date !== data.evidence.end_date}<p
								>
									{pooledDays[locale]}
								</p>{/if}
							<p>
								{lineRankingFloor(measure, info.ranking_floors?.line, locale) ??
									t(
										`Minimum to rank an entry is ${minimum}.`,
										`Le minimum pour figurer au classement est de ${minimum}.`,
									)}
							</p>
							{#if data.coverage_note}<p>{data.coverage_note[locale]}</p>{/if}
							<RecordActions
								{locale}
								title={listLabel}
								href={links.share}
								csv={links.csv}
								citation={rankingCitation(
									listLabel,
									measureLabel,
									record.city,
									data,
									locale,
									links.share,
									result.lastGood,
								)}
							/>
							{#if shown.length}
								{@const countText = t(
									`Showing ${tally(shown.length, locale)} of ${tally(data.ranked_count, locale)} ranked entries.`,
									`${tally(shown.length, locale)} entrées affichées sur ${tally(data.ranked_count, locale)} classées.`,
								)}
								{#if shown.some((row) => row.ranking_bound != null)}
									<p>{cautiousRanking[locale]}</p>
								{/if}
								{#if shown.some((row) => row.range.method !== 'histogram_half_bin' && row.range.lower != null && row.range.upper != null)}
									<p>
										{t(
											'Nearby positions may be hard to distinguish when their ranges overlap.',
											'Les positions voisines peuvent être difficiles à distinguer lorsque leurs intervalles se chevauchent.',
										)}
									</p>
								{/if}
								<ol class="m-0 list-none p-0" role="list">
									{#each shown as row (row.id)}
										{@const basis =
											measure === 'excess_wait_time'
												? waitingRankingBasis(row.counts, locale)
												: timingBasis(row.counts, locale)}
										<li class="ranking-row border-t border-border py-3">
											<span class="tabular-nums"
												><span class="sr-only">{t('Rank', 'Rang')} </span>{tally(
													row.rank,
													locale,
												)}</span
											>
											<div class="min-w-0 wrap-anywhere font-medium">
												{@render entity(row)}
												{#if kind === 'line' && serviceClass === 'all'}
													<p class="text-small font-normal">
														{row.classes.map((key) => classText(key, locale)).join(', ')}
													</p>
												{/if}
											</div>
											<dl class="row-readings grid min-w-0 grid-cols-2 gap-x-3 gap-y-2">
												<div>
													<dt class="sr-only">{measureLabel}</dt>
													<dd class="font-semibold tabular-nums">
														{rankingValue(row.value, measure, locale)}
													</dd>
												</div>
												<div>
													<dt class="sr-only">{t('Counted', 'Comptés')}</dt>
													<dd>{rankingSample(row, measure, locale)}</dd>
												</div>
												<div title={data.range_notes[row.range.method]?.[locale]}>
													<dt class="text-small">{rankingRangeLabel(row.range.method, locale)}</dt>
													<dd>{rankingRange(row, measure, locale)}</dd>
												</div>
												{#if basis}
													<div class="col-span-2">
														<dt class="sr-only">{t('Timing sources', 'Sources des heures')}</dt>
														<dd>{basis}</dd>
													</div>
												{/if}
											</dl>
										</li>
									{/each}
								</ol>
								{#each [...new Set(shown.map((row) => row.range.method))] as method (method)}
									{#if data.range_notes[method]}<p class="text-small">
											{data.range_notes[method][locale]}
										</p>{/if}
								{/each}
								<div class="flex flex-wrap items-center gap-3">
									<div role="status">
										<FilterSummary
											count={shown.length}
											countLabel={{ singular: countText, plural: countText }}
											{locale}
											clearLabel={t('Clear filters', 'Effacer les filtres')}
											canClear={kind === 'line' && serviceClass !== null}
											onClear={() => select(kind, measure, null)}
										/>
									</div>
									{#if limit < data.rows.length}
										<Button variant="outline" size="cta-sm" onclick={() => (limit += 12)}
											>{t('Show more', 'Afficher la suite')}</Button
										>
									{/if}
								</div>
							{/if}
							<details class="min-w-0">
								<summary class="min-h-11 cursor-pointer py-3"
									>{t('Excluded, with the reason', 'Exclusions et motifs')} ({tally(
										data.excluded.length,
										locale,
									)})</summary
								>
								{#if data.excluded.length}
									<ul class="grid gap-2">
										{#each data.excluded as row (row.id)}
											<li class="wrap-anywhere">
												<strong>{@render entity(row)}</strong> · {exclusionText(
													row,
													measure,
													locale,
												)}
											</li>
										{/each}
									</ul>
								{:else}
									<p>{t('No exclusions for this list.', 'Aucune exclusion pour cette liste.')}</p>
								{/if}
							</details>
						{/if}
					{/await}
				{/if}
			</section>
		</Card>
	</div>
</Surface>

<style>
	.ranking-row {
		display: grid;
		grid-template-columns: 2.5ch minmax(0, 1fr);
		gap: 0.5rem 0.75rem;
	}
	.row-readings {
		grid-column: 2;
	}
	@media (min-width: 64rem) {
		.ranking-row {
			grid-template-columns: 2.5ch minmax(0, 1fr) minmax(0, 1.6fr);
		}
		.row-readings {
			grid-column: 3;
			grid-template-columns: repeat(3, minmax(0, 1fr));
		}
	}
</style>
