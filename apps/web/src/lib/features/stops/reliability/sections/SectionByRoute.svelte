<script lang="ts">
	import { Button } from '@yesid/ui/button';
	import { intl, type Locale } from '#lib/i18n/index.ts';
	import { RankedRow } from '#lib/components/dataviz/index.ts';
	import type { RankedRouteRow } from '../selectors/rankedRoutes';
	import type { StopReliabilityCopy } from '../stops-reliability.copy';
	import StopReliabilityPresenter from './StopReliabilityPresenter.svelte';

	/** A long list shows its first rows, then "Show all": the rest stay in the page, hidden. */
	const FIRST_ROWS = 5;

	interface SectionByRouteProps {
		rows: readonly RankedRouteRow[];
		locale: Locale;
		copy: StopReliabilityCopy;
		presentation?: 'standalone' | 'article-body';
	}
	let { rows, locale, copy, presentation = 'standalone' }: SectionByRouteProps = $props();

	const listId = $props.id();
	let showAll = $state(false);
	const bounded = $derived(rows.length > FIRST_ROWS);
</script>

{#if rows.length > 0}
	<StopReliabilityPresenter
		heading={copy.byRoute}
		metricKey="avgDelay"
		{locale}
		{presentation}
		dataSlot="stop-by-route"
	>
		<ul class="stop-reliability-route-list" role="list" id={listId}>
			{#each rows as row, index (row.key)}
				<li hidden={bounded && !showAll && index >= FIRST_ROWS}>
					<a
						class="stop-reliability-route-link"
						href={row.href}
						data-sveltekit-preload-data="hover"
					>
						<RankedRow
							bare
							rank={row.rank}
							title={row.title}
							severity={row.severity}
							value={row.value}
							domain={row.domain}
							unit={row.unit}
							display={row.display}
							{locale}
						/>
						<span class="sr-only">{row.ariaLabel}</span>
					</a>
				</li>
			{/each}
		</ul>
		{#if bounded}
			<div>
				<Button
					variant="outline"
					size="sm"
					class="min-h-11"
					aria-expanded={showAll}
					aria-controls={listId}
					onclick={() => (showAll = !showAll)}
				>
					{showAll
						? copy.showFewerLines
						: copy.showAllLines(intl.number(locale).format(rows.length))}
				</Button>
			</div>
		{/if}
	</StopReliabilityPresenter>
{/if}

<style>
	.stop-reliability-route-list {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.stop-reliability-route-link {
		display: block;
		color: inherit;
		text-decoration: none;
		border-radius: var(--radius-md);
	}
	.stop-reliability-route-link:focus-visible {
		outline: 2px solid var(--ring);
		outline-offset: 2px;
	}
</style>
