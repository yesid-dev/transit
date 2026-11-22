<script lang="ts">
	import type { Snippet } from 'svelte';

	interface Props {
		title: string;
		titleId: string;
		testId?: string;
		beforeTitle?: Snippet;
		afterTitle?: Snippet;
		children: Snippet;
	}

	let { title, titleId, testId, beforeTitle, afterTitle, children }: Props = $props();
</script>

<article class="info-page" data-testid={testId} aria-labelledby={titleId}>
	<header>
		{@render beforeTitle?.()}
		<h1 id={titleId}>{title}</h1>
		{@render afterTitle?.()}
	</header>
	<div class="info-page__sections">
		{@render children()}
	</div>
</article>

<style>
	.info-page {
		display: grid;
		gap: 3rem;
		width: min(100% - 2rem, 52rem);
		margin-inline: auto;
		padding-block: 4rem 6rem;
	}

	header,
	.info-page__sections > :global(section) {
		display: grid;
		gap: 1rem;
	}

	.info-page__sections {
		display: grid;
		gap: 2.5rem;
		font-size: var(--text-reading);
	}

	h1,
	:where(.info-page) :global(h2),
	:where(.info-page) :global(p),
	:where(.info-page) :global(ul) {
		margin: 0;
	}

	h1,
	:where(.info-page) :global(h2) {
		font-family: var(--font-heading);
		line-height: 1.25;
	}

	h1 {
		font-size: var(--text-display);
	}

	:where(.info-page) :global(h2) {
		font-size: var(--text-reading-heading);
	}

	:where(.info-page) :global(p),
	:where(.info-page) :global(li) {
		max-width: var(--measure-lede);
		color: var(--secondary-foreground);
		line-height: 1.7;
	}

	:where(.info-page) :global(ul) {
		display: grid;
		gap: 0.5rem;
		padding-inline-start: 1.25rem;
	}

	@media (--desktop-min) {
		.info-page__sections {
			font-size: var(--text-reading-desktop);
		}

		:where(.info-page) :global(h2) {
			font-size: var(--text-reading-heading-desktop);
		}
	}
</style>
