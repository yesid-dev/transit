<script lang="ts">
	import type { HistoricAvailabilityIndex } from '#lib/v1/schemas/index.ts';
	import type { Resource } from '#lib/v1/resource.svelte.ts';
	import ResourceBoundary from '#lib/components/surface/ResourceBoundary.svelte';
	import { type Locale } from '#lib/i18n/index.ts';
	import { formatDateKey } from '#lib/utils/time.ts';
	import { copy as healthCopy } from '#lib/features/health/health.copy.ts';
	import { selectHistoryCoverage } from '#lib/features/health/selectors/historyCoverage.ts';
	import { historyDepthCopy } from './historyDepth.copy';

	let {
		resource,
		locale,
		detailsHref,
	}: {
		resource: Resource<HistoricAvailabilityIndex | null>;
		locale: Locale;
		detailsHref: string;
	} = $props();
	const t = $derived(historyDepthCopy[locale]);
	const labels = $derived(healthCopy[locale].historyCoverage);
	const dimensions = ['network', 'lines', 'stops'] as const;
	const rows = $derived(selectHistoryCoverage(resource.data));
</script>

<div class="history-depth" data-testid="history-depth">
	<p>{t.intro}</p>
	<p>{t.limits}</p>
	{#if resource.error && resource.data}
		<p role="status" class="history-notice">{t.retained}</p>
	{/if}
	{#if resource.settled && !resource.data && !resource.error}
		<p role="status">{t.noList}</p>
	{:else}
		<ResourceBoundary {resource} lang={locale}>
			{#snippet children(index)}
				<dl class="history-source">
					<div>
						<dt>{t.published}</dt>
						<dd>{index.generated_utc}</dd>
					</div>
					<div>
						<dt>{t.method}</dt>
						<dd>{index.methodology_version ?? t.unknown}</dd>
					</div>
					<div>
						<dt>{t.generation}</dt>
						<dd>{index.publish_generation_id ?? t.unknown}</dd>
					</div>
				</dl>
				{#each dimensions as dimension (dimension)}
					{@const family = rows.find((row) => row.key === dimension)}
					<section class="history-dimension" data-dimension={dimension}>
						<h3>{labels.families[dimension]}</h3>
						{#if !family?.metrics.length}
							<p>{t.noInventory}</p>
						{:else}
							<!-- A named overflow region must be reachable for keyboard scrolling. -->
							<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
							<div
								class="history-scroll"
								role="region"
								aria-label={t.scroll(labels.families[dimension])}
								tabindex="0"
							>
								<table>
									<caption>{labels.families[dimension]}</caption>
									<thead
										><tr
											><th scope="col">{t.metric}</th><th scope="col">{t.first}</th><th scope="col"
												>{t.last}</th
											><th scope="col">{t.gaps}</th><th scope="col">{t.aggregation}</th></tr
										></thead
									>
									<tbody>
										{#each family.metrics as metric (metric.key)}
											<tr data-metric={metric.key} data-aggregation={metric.aggregation}>
												<th scope="row">{labels.metrics[metric.key]}</th>
												<td data-date="first"
													>{#if metric.firstDate}<time datetime={metric.firstDate}
															>{formatDateKey(metric.firstDate, locale, true)}</time
														>{:else}{t.unknown}{/if}</td
												>
												<td data-date="last"
													>{#if metric.lastDate}<time datetime={metric.lastDate}
															>{formatDateKey(metric.lastDate, locale, true)}</time
														>{:else}{t.unknown}{/if}</td
												>
												<td data-gaps>
													{#if metric.gaps == null}{t.unknownGaps}
													{:else if metric.gaps.length === 0}{t.noGaps}
													{:else}<ul>
															{#each metric.gaps as gap, i (i)}<li>
																	<time datetime={gap.startDate}
																		>{formatDateKey(gap.startDate, locale, true)}</time
																	>
																	–
																	<time datetime={gap.endDate}
																		>{formatDateKey(gap.endDate, locale, true)}</time
																	>{#if gap.reason}: {gap.reason}{/if}
																</li>{/each}
														</ul>{/if}
												</td>
												<td data-limit>{labels.aggregation[metric.aggregation]}</td>
											</tr>
										{/each}
									</tbody>
								</table>
							</div>
						{/if}
					</section>
				{/each}
			{/snippet}
		</ResourceBoundary>
	{/if}
	<a href={detailsHref}>{t.details}</a>
</div>

<style>
	.history-depth {
		min-inline-size: 0;
		display: grid;
		gap: 1.25rem;
	}
	.history-depth p {
		margin: 0;
		line-height: 1.65;
	}
	.history-source {
		display: grid;
		gap: 0.75rem;
		margin: 0;
	}
	.history-source div {
		min-inline-size: 0;
	}
	.history-source dt {
		font-weight: 600;
	}
	.history-source dd {
		margin: 0.25rem 0 0;
		overflow-wrap: anywhere;
	}
	.history-notice {
		border-inline-start: 2px solid currentColor;
		padding-inline-start: 1rem;
	}
	.history-dimension {
		min-inline-size: 0;
	}
	h3 {
		font-weight: 600;
		margin-block: 0 0.75rem;
	}
	.history-scroll {
		overflow-x: auto;
		max-inline-size: 100%;
		padding-block-end: 0.75rem;
	}
	.history-scroll:focus-visible {
		outline: 2px solid currentColor;
		outline-offset: 2px;
	}
	table {
		border-collapse: collapse;
		text-align: start;
		inline-size: 100%;
		min-inline-size: 44rem;
	}
	caption {
		text-align: start;
		font-weight: 600;
		padding-block-end: 0.75rem;
	}
	th,
	td {
		vertical-align: top;
		padding: 0.75rem;
		border-block-end: 1px solid var(--border);
	}
	th {
		font-weight: 600;
	}
	td {
		min-inline-size: 9rem;
	}
	ul {
		margin: 0;
		padding-inline-start: 1rem;
	}
	a {
		display: inline-flex;
		align-items: center;
		min-block-size: 44px;
		text-decoration: underline;
		text-underline-offset: 0.2em;
	}
</style>
