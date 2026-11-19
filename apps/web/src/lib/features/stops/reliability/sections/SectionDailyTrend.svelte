<script lang="ts">
	import type { Locale } from '#lib/i18n/index.ts';
	import { AbsentValue } from '#lib/components/edge/index.ts';
	import type { DayByDay } from '../selectors/dailyTrend';
	import { dayByDayDates, dayByDayScope } from '../selectors/dayByDayText';
	import type { StopReliabilityCopy } from '../stops-reliability.copy';
	import StopDailyChart from './StopDailyChart.svelte';
	import StopReliabilityPresenter from './StopReliabilityPresenter.svelte';

	interface SectionDailyTrendProps {
		view: DayByDay;
		locale: Locale;
		copy: StopReliabilityCopy;
		presentation?: 'standalone' | 'article-body';
	}
	let { view, locale, copy, presentation = 'standalone' }: SectionDailyTrendProps = $props();

	const uid = $props.id();
	const dates = $derived(dayByDayDates(view, locale));
	const scope = $derived(dayByDayScope(view, locale));
</script>

<StopReliabilityPresenter
	as="section"
	heading={copy.dayByDay.heading}
	metricKey="severe"
	{locale}
	{presentation}
	spacing="comfortable"
	dataSlot="stop-daily-trend"
	dataMount={view.basis ?? undefined}
>
	{#if view.rows.length === 0 || dates == null}
		<AbsentValue variant="block" reason="no-observations" {locale} />
	{:else}
		<StopDailyChart {view} {dates} {locale} {copy} />
		<div class="day-scope" data-slot="day-by-day-scope">
			<h3 class="day-scope__label" id={`${uid}-scope`}>{copy.dayByDay.scopeLabel}</h3>
			<ul class="day-scope__list" aria-labelledby={`${uid}-scope`}>
				{#each scope as line (line)}
					<li>{line}</li>
				{/each}
			</ul>
		</div>
	{/if}
</StopReliabilityPresenter>

<style>
	.day-scope {
		display: grid;
		gap: 0.375rem;
		max-width: var(--measure-body);
	}
	.day-scope__label {
		margin: 0;
		font-size: var(--text-small);
		font-weight: 600;
		color: var(--foreground);
	}
	.day-scope__list {
		display: grid;
		gap: 0.25rem;
		margin: 0;
		padding-inline-start: 1.25rem;
		color: var(--muted-foreground);
		font-size: var(--text-small);
		line-height: 1.5;
	}
</style>
