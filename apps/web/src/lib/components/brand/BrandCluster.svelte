<script lang="ts">
	import { ProductBrand } from '@yesid/ui/brand';
	import { YESID_HOUSE_LINK } from '#lib/content/nav.ts';

	let { productHref }: { productHref: string } = $props();
</script>

<span class="footer-brand" data-testid="footer-brand">
	<span class="footer-brand-layout">
		<ProductBrand
			product="Transit"
			href={productHref}
			houseHref={YESID_HOUSE_LINK.href}
			houseExternal
			houseStyle="font-size: 1.125rem; line-height: 1.75rem"
			productStyle="font-size: 1.5rem; line-height: 2rem; white-space: nowrap"
			dividerStyle="block-size: 18px; display: var(--footer-brand-divider, block)"
			style="display: flex; flex-direction: var(--footer-brand-direction, row); align-items: var(--footer-brand-align, center); gap: var(--footer-brand-gap, var(--nav-split-space, 0.5rem))"
		/>
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
	.footer-brand-layout {
		display: block;
	}
	/* The house mark and the product name together are wider than a phone's brand column at 200%
	   text, before any gap. Stack them in reading order there; the decorative divider has nothing
	   left to split and steps out. */
	@container footer-brand (inline-size < 9.5em) {
		.footer-brand-layout {
			--footer-brand-direction: column;
			--footer-brand-align: flex-start;
			--footer-brand-gap: 0;
			--footer-brand-divider: none;
		}
	}
</style>
