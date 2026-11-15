<script lang="ts">
	import type { Locale } from '#lib/i18n/index.ts';
	import type { Manifest } from '#lib/v1/schemas/index.ts';
	import HomePulseLive from './HomePulseLive.svelte';
	import HomeRanking from './HomeRanking.svelte';
	import HomeRecord from './HomeRecord.svelte';
	import { homePulseCopy } from './homePulse.copy';

	interface Props {
		readonly locale: Locale;
		/** Absent before the data context boots; every card still renders its shape and links. */
		readonly manifest: Manifest | null;
	}

	let { locale, manifest }: Props = $props();
	const t = $derived(homePulseCopy[locale]);
</script>

<!-- One subject, two clocks: the record leads, what is live now sits beside it, never mixed. -->
<div class="home-pulse" data-slot="home-pulse">
	<div class="pulse-cards">
		<HomeRecord {locale} {manifest} copy={t} />
		{#key manifest != null}
			<HomePulseLive {locale} {manifest} copy={t} />
		{/key}
	</div>
	{#if manifest}
		<HomeRanking {locale} copy={t} />
	{/if}
</div>

<style>
	.home-pulse,
	.pulse-cards {
		display: grid;
		gap: 1rem;
		min-width: 0;
	}
	/* Static cards: a neutral 1px edge, no hover (they are not links). */
	.home-pulse :global(:is(.home-record, .home-live, .pulse-worst)) {
		display: flex;
		flex-direction: column;
		gap: 1.25rem;
		min-width: 0;
		padding: clamp(1rem, 2.5vw, 1.5rem);
		background: var(--card);
		border: 1px solid var(--border);
		border-radius: var(--radius-lg);
	}
	.home-pulse :global(h2) {
		margin: 0;
		font-family: var(--font-heading);
		font-size: var(--text-heading);
		font-weight: 800;
		letter-spacing: var(--tracking-tight);
	}
	.home-pulse :global(.home-card-actions) {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		margin: auto 0 0;
	}
	.home-pulse :global(.home-card-action) {
		display: inline-flex;
		align-items: center;
		min-height: 44px;
		padding: 0.5rem 1rem;
		color: var(--foreground);
		font-weight: 600;
		text-decoration: none;
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
	}
	.home-pulse :global(.home-card-action:hover) {
		color: var(--primary);
		border-color: var(--primary);
	}
	.home-pulse :global(.home-card-action:focus-visible) {
		outline: 2px solid var(--primary);
		outline-offset: 2px;
	}
	@media (--desktop-min) {
		.home-pulse {
			gap: 1.5rem;
		}
		.pulse-cards {
			grid-template-columns: minmax(0, 2fr) minmax(0, 1fr);
			gap: 1.5rem;
		}
	}
</style>
