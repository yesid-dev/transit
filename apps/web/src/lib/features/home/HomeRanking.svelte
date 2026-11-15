<script lang="ts">
	import { getV1Runtime } from '#lib/v1/runtime.ts';
	import { onMount } from 'svelte';
	import { transitDisplay } from '#lib/site/transitDisplayContext.ts';
	import { getLocalizeHref, type Locale } from '#lib/i18n/index.ts';
	import { routeFor } from '#lib/nav/index.ts';
	import { getPublishedReliabilityIndex, getHotspots } from '#lib/v1/repositories/historic.ts';
	import { createResource } from '#lib/v1/resource.svelte.ts';
	import { fmtCount } from '#lib/utils/index.ts';
	import { fmtLocalePct } from '#lib/utils/format.ts';
	import { formatWeek } from './homeRecord';
	import { lineList, stopList, type InvestigateList, type InvestigateRow } from './homeRanking';
	import type { HomePulseCopy } from './homePulse.copy';

	const display = transitDisplay();

	interface Props {
		readonly locale: Locale;
		readonly copy: HomePulseCopy;
	}

	let { locale, copy: t }: Props = $props();
	const localizeHref = getLocalizeHref();

	/** Rows each list shows; the list reserves their height before its data arrives. */
	const RANK_ROWS = 3;
	/**
	 * The gauge every reserved row holds: 65 characters, longer than any name in the published
	 * weekly rankings when this was written (64). A longer name still shows whole and wraps; only
	 * then does the list grow when it arrives.
	 */
	const GAUGE_NAME = 'Terminus centre-ville / Station Henri-Bourassa <> Parc industriel';
	const GAUGE_ROWS = Array.from({ length: RANK_ROWS }, (_, index) => index + 1);

	const hotspots = createResource((signal) => getHotspots({ signal }), {
		key: () => 'home-hotspots',
	});
	const weeklyIndex = createResource((signal) => getPublishedReliabilityIndex({ signal }), {
		key: () => 'home-weekly-ranking',
	});
	const runtime = getV1Runtime();
	onMount(() => runtime.clock.subscribe());

	interface Ranking {
		readonly list: InvestigateList;
		readonly settled: boolean;
		readonly error: unknown;
	}
	// Lines and stops come from different files with their own weeks; each list states its own.
	const lines: Ranking = $derived({
		list: lineList(hotspots.data, display.directory, {
			now: runtime.clock.serverNow,
			limit: RANK_ROWS,
		}),
		settled: hotspots.settled,
		error: hotspots.error,
	});
	const stops: Ranking = $derived({
		list: stopList(weeklyIndex.data, { now: runtime.clock.serverNow, limit: RANK_ROWS }),
		settled: weeklyIndex.settled,
		error: weeklyIndex.error,
	});

	const pct = (value: number) => fmtLocalePct(value, locale) ?? '';
	const period = (list: Extract<InvestigateList, { state: 'ranked' }>) =>
		t.rankPeriod
			.replace('{dates}', formatWeek(list.window, locale))
			.replace('{n}', String(list.days));
	// The period line reserves the longest week it can name, so nothing moves when it arrives.
	const longestPeriod = $derived(
		t.rankPeriod
			.replace('{dates}', formatWeek({ from: '2026-12-28', to: '2027-01-03' }, locale))
			.replace('{n}', '7'),
	);
	const rowHref = (row: InvestigateRow) =>
		localizeHref(routeFor({ kind: row.kind, id: row.id }), locale);
	const gauge = $derived({
		value: pct(100),
		readings: t.rankReadings.replace('{n}', fmtCount(9_999_999, { locale }) ?? ''),
	});
</script>

<section class="pulse-worst" data-slot="home-pulse-worst" aria-labelledby="home-rank-title">
	<h2 id="home-rank-title">{t.rankTitle}</h2>
	<div class="rank-notes">
		<p class="rank-measure">{t.rankMeasure}</p>
		<p>{t.rankOrder}</p>
	</div>
	<div class="rank-cols">
		{@render rankList(t.worstLines, lines, 'lines')}
		{@render rankList(t.worstStops, stops, 'stops')}
	</div>
	<p class="home-card-actions">
		<a class="home-card-action" href={localizeHref('/hotspots', locale)}>{t.openRankings}</a>
	</p>
</section>

{#snippet rankList(title: string, ranking: Ranking, key: string)}
	<section class="rank-list" aria-labelledby={`rank-${key}`}>
		<h3 id={`rank-${key}`}>{title}</h3>
		<p class="slot rank-period">
			<span
				>{#if ranking.list.state === 'ranked'}{period(ranking.list)}{/if}</span
			>
			<span class="reserve" aria-hidden="true" data-reserve={longestPeriod}></span>
		</p>
		<div class="rank-body" aria-busy={!ranking.settled}>
			<!-- Three rows of the gauge, drawn invisibly under the list: the taller one sets the height. -->
			<ol class="rank-gauge" aria-hidden="true">
				{#each GAUGE_ROWS as position (position)}
					<li>
						<span class="rank-row">
							<span class="rank-pos">{position}</span>
							<span class="rank-id">
								<span class="rank-ink">
									<span class="rank-plate">000</span><span class="rank-name">{GAUGE_NAME}</span>
								</span>
							</span>
							<span class="rank-meta">
								<span class="rank-value">{gauge.value}</span>
								<span class="rank-readings">{gauge.readings}</span>
							</span>
						</span>
					</li>
				{/each}
			</ol>
			{#if ranking.list.state === 'ranked'}
				<ol>
					{#each ranking.list.rows as row, index (row.id)}
						<li>
							<a class="rank-row" href={rowHref(row)}>
								<span class="rank-pos" aria-hidden="true">{index + 1}</span>
								<span class="rank-id">
									<span class="rank-ink" aria-hidden="true">
										{#if row.number}<span class="rank-plate">{row.number}</span>{/if}
										{#if row.name}<span class="rank-name">{row.name}</span>{/if}
									</span>
									<span class="sr-only">{row.spoken}, </span>
								</span>
								<span class="rank-meta">
									<!-- The note above names the measure; each row repeats it for screen readers. -->
									<span class="rank-value" aria-hidden="true">{pct(row.latePct)}</span>
									<span class="sr-only">{t.lateRate.replace('{pct}', pct(row.latePct))}, </span>
									<span class="rank-readings"
										>{t.rankReadings.replace('{n}', fmtCount(row.readings, { locale }) ?? '')}</span
									>
								</span>
							</a>
						</li>
					{/each}
				</ol>
			{:else if ranking.error}
				<p class="rank-absent" role="status">{t.worstError}</p>
			{:else if ranking.settled}
				<p class="rank-absent" role="status">
					{ranking.list.state === 'unpublished' ? t.worstUnavailable : t.worstNotCurrent}
				</p>
			{/if}
		</div>
	</section>
{/snippet}

<style>
	/*
	 * Each list reserves its period line and three rows before its data arrives: the rows of a
	 * long-name gauge, drawn invisibly under the real list. Names are never cut; they wrap.
	 * Phones: identity, then share and readings. From 768px: one row, figures on the right.
	 */
	.rank-notes {
		display: grid;
		gap: 0.25rem;
		max-width: var(--measure-body);
	}
	.rank-notes p {
		margin: 0;
		font-size: var(--text-small);
		line-height: 1.5;
		color: var(--muted-foreground);
	}
	.rank-notes .rank-measure {
		color: var(--foreground);
		font-weight: 600;
	}
	.rank-cols {
		display: grid;
		gap: 1.75rem;
		min-width: 0;
	}
	.rank-list {
		min-width: 0;
	}
	.rank-list h3 {
		margin: 0;
		padding-bottom: 0.5rem;
		font-family: var(--font-heading);
		font-size: var(--text-body);
		font-weight: 800;
		border-bottom: 1px solid var(--border-subtle);
	}
	/* A slot holds its text and the longest text it may hold; the taller one sets its height. */
	.slot {
		display: grid;
		align-items: start;
	}
	.slot > * {
		grid-area: 1 / 1;
		min-width: 0;
	}
	.reserve {
		visibility: hidden;
	}
	.reserve::after {
		content: attr(data-reserve);
	}
	.rank-period {
		margin: 0.5rem 0 0;
		font-size: var(--text-small);
		font-weight: 600;
		line-height: 1.45;
		color: var(--secondary-foreground);
	}
	.rank-body {
		display: grid;
		align-items: start;
	}
	.rank-body > * {
		grid-area: 1 / 1;
		min-width: 0;
	}
	.rank-gauge {
		visibility: hidden;
	}
	.rank-list ol {
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.rank-row {
		display: grid;
		grid-template-columns: 1.25rem minmax(0, 1fr);
		grid-template-areas:
			'pos id'
			'pos meta';
		align-content: center;
		column-gap: 0.75rem;
		row-gap: 0.125rem;
		box-sizing: border-box;
		min-height: 44px;
		padding-block: 0.5rem;
		color: var(--foreground);
		text-decoration: none;
		border-bottom: 1px solid var(--border-subtle);
	}
	.rank-row:hover .rank-name {
		color: var(--accent-text);
		text-decoration: underline;
		text-underline-offset: 0.2em;
	}
	.rank-row:focus-visible {
		outline: 2px solid var(--accent-text);
		outline-offset: 2px;
	}
	.rank-pos {
		grid-area: pos;
		color: var(--muted-foreground);
		font-size: var(--text-small);
		line-height: 1.75rem;
		font-variant-numeric: tabular-nums;
	}
	.rank-id {
		grid-area: id;
		display: flex;
		min-width: 0;
	}
	.rank-ink {
		display: flex;
		align-items: flex-start;
		gap: 0.75rem;
		min-width: 0;
	}
	.rank-plate {
		display: inline-flex;
		flex: none;
		align-items: center;
		justify-content: center;
		box-sizing: border-box;
		min-width: 2.75rem;
		height: 1.75rem;
		padding: 0 0.45rem;
		font-family: var(--font-heading);
		font-weight: 700;
		line-height: 1;
		font-variant-numeric: tabular-nums;
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
	}
	.rank-name {
		min-width: 0;
		padding-top: 0.15rem;
		line-height: 1.45;
		text-wrap: pretty;
		/* A word longer than the row may break only when nothing else fits (200% text). */
		overflow-wrap: anywhere;
	}
	.rank-meta {
		grid-area: meta;
		display: flex;
		align-items: baseline;
		gap: 0 0.75rem;
		min-width: 0;
		white-space: nowrap;
	}
	.rank-row:has(.rank-plate) .rank-meta {
		padding-inline-start: 3.5rem;
	}
	.rank-value {
		font-size: var(--text-card-title);
		font-weight: 700;
		line-height: 1.5rem;
		font-variant-numeric: tabular-nums;
	}
	.rank-readings {
		color: var(--muted-foreground);
		font-size: var(--text-small);
		font-variant-numeric: tabular-nums;
	}
	/* Padding, not margin: a margin would collapse through the reserved body and add to its height. */
	.rank-absent {
		margin: 0;
		padding-top: 0.75rem;
		color: var(--secondary-foreground);
		font-size: var(--text-small);
	}
	@media (--tablet-min) {
		.rank-row {
			grid-template-columns: 1.25rem minmax(0, 1fr) auto;
			grid-template-areas: 'pos id meta';
			align-items: center;
		}
		.rank-row:has(.rank-plate) .rank-meta {
			padding-inline-start: 0;
		}
		.rank-meta {
			flex-direction: column;
			align-items: flex-end;
			gap: 0;
		}
	}
	/* Desktop: lines beside stops (6 + 6). */
	@media (--desktop-min) {
		.rank-cols {
			grid-template-columns: repeat(2, minmax(0, 1fr));
			column-gap: 2.5rem;
		}
	}
</style>
