<script lang="ts">
	import { RankedRow } from '#lib/components/dataviz/index.ts';
	import { SectionHeading } from '@yesid/ui/brand';
	import type { Locale } from '#lib/i18n/index.ts';
	import { NOT_REPORTED_DOMAIN, type NotReportedVM } from '../selectors/notReportedLines';

	interface SectionNotReportedProps {
		list: NotReportedVM;
		heading: string;
		caveat: string;
		noLiveData: { heading: string; caveat: string };
		hiddenNote: (n: number) => string;
		locale: Locale;
		headingLevel?: 2 | 3;
	}
	let {
		list,
		heading,
		caveat,
		noLiveData,
		hiddenNote,
		locale,
		headingLevel = 2,
	}: SectionNotReportedProps = $props();
</script>

<section class="receipt-not-reported" data-slot="receipt-not-reported" aria-label={heading}>
	{#if list.rows.length > 0}
		<SectionHeading level={headingLevel} overline={heading} />
		<p class="receipt-not-reported-caveat" data-slot="receipt-not-reported-caveat">{caveat}</p>
		<ul class="receipt-not-reported-list" role="list" aria-label={heading}>
			{#each list.rows as row (row.key)}
				<li class="receipt-not-reported-item">
					<a
						class="receipt-not-reported-link"
						href={row.href}
						data-sveltekit-preload-data="hover"
						data-slot="not-reported-link"
						aria-label={row.ariaLabel}
					>
						<RankedRow
							bare
							rank={row.rank}
							title={row.title}
							subtitle={row.subtitle}
							severity={row.severity}
							value={row.value}
							domain={NOT_REPORTED_DOMAIN}
							display={row.display}
							absentReason="not-reported"
							{locale}
						/>
					</a>
				</li>
			{/each}
		</ul>
	{/if}
	{#if list.noLiveData.length > 0}
		<SectionHeading level={headingLevel} overline={noLiveData.heading} />
		<p class="receipt-not-reported-caveat" data-slot="receipt-no-live-data-caveat">
			{noLiveData.caveat}
		</p>
		<ul class="receipt-no-live-data-list" role="list" aria-label={noLiveData.heading}>
			{#each list.noLiveData as line (line.key)}
				<li>
					<a href={line.href} data-sveltekit-preload-data="hover" data-slot="no-live-data-link">
						{line.title}
					</a>
				</li>
			{/each}
		</ul>
	{/if}
	{#if list.hidden != null && list.hidden > 0}
		<p class="receipt-not-reported-note" data-slot="receipt-not-reported-hidden">
			{hiddenNote(list.hidden)}
		</p>
	{/if}
</section>

<style>
	.receipt-not-reported {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}
	.receipt-not-reported-caveat,
	.receipt-not-reported-note {
		margin: 0;
		max-width: 100%;
		font-family: var(--font-mono);
		font-size: var(--text-micro);
		line-height: 1.4;
		color: var(--muted-foreground);
	}
	.receipt-not-reported-caveat {
		font-family: var(--font-body);
		font-size: var(--text-reading-caption);
		line-height: 1.6;
	}
	.receipt-not-reported-list {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 0.5rem 1.25rem;
		max-width: 100%;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.receipt-not-reported-item {
		display: block;
	}
	.receipt-no-live-data-list {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem 1.25rem;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.receipt-not-reported-link {
		display: block;
		text-decoration: none;
		color: inherit;
		border-radius: var(--radius-lg);
	}
	.receipt-not-reported-link:focus-visible {
		outline: 2px solid var(--ring);
		outline-offset: 2px;
	}
	@media (--desktop-min) {
		.receipt-not-reported-list {
			grid-template-columns: repeat(auto-fit, minmax(min(16rem, 100%), 1fr));
		}
	}
</style>
