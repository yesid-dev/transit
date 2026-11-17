<script lang="ts">
	import { Wordmark } from '@yesid/ui/brand';
	import { YESID_HOUSE_LINK } from '#lib/content/nav.ts';

	let { productHref }: { productHref: string } = $props();
</script>

<span class="footer-brand" data-testid="footer-brand">
	<span class="footer-brand-row" data-testid="footer-brand-row">
		<Wordmark href={YESID_HOUSE_LINK.href} external animate={false} class="text-lg" />
		<span class="footer-divider" aria-hidden="true"></span>
		<a
			href={productHref}
			data-testid="footer-wordmark"
			class="footer-product font-heading text-2xl font-bold text-[var(--foreground)]"
		>
			transit
		</a>
	</span>
</span>

<style>
	/* The footer gives the brand its own column: measure that column, not the viewport. The row
	   fits at every width a phone leaves it at 100% text, and stacks below. */
	.footer-brand {
		display: block;
		container: footer-brand / inline-size;
		inline-size: 100%;
		max-inline-size: 100%;
		min-inline-size: 0;
	}
	.footer-brand-row {
		display: flex;
		align-items: center;
		/* The kit's one split space, the same on both sides of the divider (header and footer). */
		gap: var(--nav-split-space, 0.5rem);
	}
	.footer-product {
		display: inline-flex;
		align-items: center;
		min-block-size: var(--size-tap-min);
		white-space: nowrap;
		letter-spacing: -0.01em;
		border-radius: var(--radius-sm);
		transition: color var(--duration-fast) var(--ease-default);
	}
	.footer-product:hover {
		color: var(--primary);
	}
	.footer-product:focus-visible {
		outline: 2px solid var(--ring);
		outline-offset: 2px;
	}
	.footer-divider {
		display: inline-block;
		width: 2px;
		height: 18px;
		background: var(--border-brand);
		flex-shrink: 0;
	}
	/* The house mark and the product name together are wider than a phone's brand column at 200%
	   text, before any gap. Stack them in reading order there; the decorative divider has nothing
	   left to split and steps out. */
	@container footer-brand (inline-size < 9.5em) {
		.footer-brand-row {
			flex-direction: column;
			align-items: flex-start;
		}
		.footer-divider {
			display: none;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.footer-product {
			transition: none;
		}
	}
</style>
