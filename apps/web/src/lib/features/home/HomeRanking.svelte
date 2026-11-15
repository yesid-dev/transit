<script lang="ts">
	import { getV1Runtime } from '#lib/v1/runtime.ts';
	import { onMount } from 'svelte';
	import { transitDisplay } from '#lib/site/transitDisplayContext.ts';
	import { getLocalizeHref, type Locale } from '#lib/i18n/index.ts';
	import { routeFor } from '#lib/nav/index.ts';
	import { getPublishedReliabilityIndex, getHotspots } from '#lib/v1/repositories/historic.ts';
	import { createPublishedWeeklyRanking } from '#lib/v1/ranking/published.ts';
	import { createResource } from '#lib/v1/resource.svelte.ts';
	import { fmtPct } from '#lib/utils/index.ts';
	import { formatDateKey } from '#lib/utils/time.ts';
	import { selectWorst, type PulseRank } from './homePulse';
	import type { HomePulseCopy } from './homePulse.copy';

	const display = transitDisplay();

	interface Props {
		readonly locale: Locale;
		readonly copy: HomePulseCopy;
	}

	let { locale, copy: t }: Props = $props();
	const localizeHref = getLocalizeHref();

	/** Rows each ranking shows; the list reserves this height before its data arrives. */
	const RANK_ROWS = 5;

	const hotspots = createResource((signal) => getHotspots({ signal }), {
		key: () => 'home-hotspots',
	});

	const rankingRuntime = getV1Runtime();
	onMount(() => rankingRuntime.clock.subscribe());
	const weeklyIndex = createResource((signal) => getPublishedReliabilityIndex({ signal }), {
		key: () => 'home-weekly-ranking',
	});
	const weeklyReader = $derived(createPublishedWeeklyRanking(weeklyIndex.data));
	const weeklyStops = $derived(weeklyReader('stop', rankingRuntime.clock.serverNow));
	const worstLines = $derived(
		selectWorst(hotspots.data, display.directory, {
			limit: RANK_ROWS,
			now: rankingRuntime.clock.serverNow,
		}),
	);
	interface PulseRanking {
		readonly ranks: readonly PulseRank[];
		readonly through: string | null;
		readonly settled: boolean;
		readonly error: unknown;
		readonly published: boolean;
	}
	const lineRanking: PulseRanking = $derived({
		ranks: worstLines?.lines ?? [],
		through: worstLines?.through ?? null,
		settled: hotspots.settled,
		error: hotspots.error,
		published: hotspots.data?.by_grain?.some((window) => window.grain === 'week') ?? false,
	});
	const stopRanking: PulseRanking = $derived({
		ranks: (weeklyStops ?? [])
			.filter((row) => row.state === 'ranked')
			.slice(0, RANK_ROWS)
			.map((row) => ({
				kind: 'stop' as const,
				id: row.id,
				label: row.name ?? row.id,
				severePct: row.severe_pct ?? null,
			})),
		through: weeklyStops?.find((row) => row.state === 'ranked')?.window_end ?? null,
		settled: weeklyIndex.settled,
		error: weeklyIndex.error,
		published: (weeklyIndex.data?.weekly_stops?.length ?? 0) > 0,
	});

	const pct = (value: number | null) => fmtPct(value, { locale, suffix: '%' });
	const rankHref = (rank: PulseRank) =>
		localizeHref(routeFor({ kind: rank.kind, id: rank.id }), locale);
</script>

<section
	class="pulse-worst"
	data-slot="home-pulse-worst"
	aria-labelledby="home-rank-title"
	style:--pulse-rows={RANK_ROWS}
>
	<h2 id="home-rank-title">{t.rankTitle}</h2>
	<p class="pulse-worst-note">{t.worstNote}</p>
	<div class="pulse-worst-lists">
		{@render rankList(t.worstLines, lineRanking, 'lines')}
		{@render rankList(t.worstStops, stopRanking, 'stops')}
	</div>
	<a class="pulse-more" href={localizeHref('/hotspots', locale)}>{t.allHotspots} →</a>
</section>

{#snippet rankList(title: string, ranking: PulseRanking, key: string)}
	<section class="pulse-rank" aria-labelledby={`pulse-${key}`}>
		<h3 id={`pulse-${key}`}>{title}</h3>
		<p class="pulse-worst-note pulse-worst-through">
			{#if ranking.through}{t.worstThrough.replace(
					'{date}',
					formatDateKey(ranking.through, locale),
				)}{/if}
		</p>
		<div class="pulse-rank-body" aria-busy={!ranking.settled}>
			{#if ranking.ranks.length}
				<ol>
					{#each ranking.ranks as rank (rank.id)}
						<li>
							<a href={rankHref(rank)}>
								<span class="pulse-rank-name">
									{#if rank.kind === 'line'}
										<span class="pulse-rank-text" title={rank.label} aria-hidden="true"
											>{rank.label}</span
										>
										<span class="sr-only">{rank.spoken}</span>
									{:else}
										<span class="pulse-rank-text" title={rank.label}>{rank.label}</span>
									{/if}
								</span>
								{#if rank.severePct != null}
									<!-- The caption above names the measure; each row repeats it for screen readers. -->
									<span class="pulse-rank-rate" aria-hidden="true">{pct(rank.severePct)}</span>
									<span class="sr-only"
										>{t.lateRate.replace('{pct}', pct(rank.severePct) ?? '')}</span
									>
								{/if}
							</a>
						</li>
					{/each}
				</ol>
			{:else if ranking.error}
				<p class="pulse-absent" role="status">{t.worstError}</p>
			{:else if ranking.settled}
				<p class="pulse-absent" role="status">
					{ranking.published ? t.worstNotCurrent : t.worstUnavailable}
				</p>
			{/if}
		</div>
	</section>
{/snippet}

<style>
	/* Each list reserves its rows before the data arrives, so nothing below it moves. */
	.pulse-worst {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		min-width: 0;
	}
	.pulse-worst-note {
		margin: 0;
		font-size: var(--text-small);
		line-height: 1.45;
		color: var(--muted-foreground);
	}
	.pulse-worst-through {
		min-height: 1lh;
	}
	.pulse-absent {
		margin: 0;
		color: var(--secondary-foreground);
		font-size: var(--text-small);
	}
	.pulse-worst-lists {
		display: grid;
		gap: 1.25rem;
	}
	.pulse-rank {
		min-width: 0;
	}
	.pulse-rank h3 {
		margin: 0 0 0.5rem;
		font-family: var(--font-heading);
		font-size: var(--text-body);
		font-weight: 800;
	}
	.pulse-rank-body {
		min-height: calc(var(--pulse-rows) * 2.75rem);
	}
	.pulse-rank ol {
		display: flex;
		flex-direction: column;
		margin: 0;
		padding: 0;
		list-style: none;
		counter-reset: pulse-rank;
	}
	.pulse-rank li {
		counter-increment: pulse-rank;
	}
	.pulse-rank a {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		height: 2.75rem;
		border-bottom: 1px solid var(--border-subtle);
		color: var(--foreground);
		text-decoration: none;
	}
	.pulse-rank a::before {
		content: counter(pulse-rank);
		flex: none;
		width: 1.25rem;
		font-family: var(--font-mono);
		color: var(--muted-foreground);
	}
	.pulse-rank a:hover {
		color: var(--accent-text);
	}
	.pulse-rank a:focus-visible,
	.pulse-more:focus-visible {
		outline: 2px solid var(--accent-text);
		outline-offset: 2px;
	}
	.pulse-rank-name {
		display: flex;
		flex: 1;
		align-items: baseline;
		gap: 0.5rem;
		min-width: 0;
	}
	.pulse-rank-text {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.pulse-rank-rate {
		flex: none;
		font-size: var(--text-small);
		font-variant-numeric: tabular-nums;
		color: var(--secondary-foreground);
	}
	.pulse-more {
		align-self: flex-start;
		min-height: 44px;
		display: inline-flex;
		align-items: center;
		color: var(--accent-text);
		font-family: var(--font-mono);
		font-size: var(--text-small);
	}
	@media (min-width: 640px) {
		.pulse-worst-lists {
			grid-template-columns: repeat(2, minmax(0, 1fr));
			column-gap: 2rem;
		}
	}
</style>
