<script lang="ts">
	import { page } from '$app/state';
	import { getLocale } from '#lib/i18n/index.ts';
	import { PageSections, type PageSectionsProps } from '@yesid/ui/layout';

	const locale = getLocale();
	const address = $derived(page.url?.href);
	const daily = $derived(/\/receipt\/?$/.test(page.url?.pathname ?? ''));
	let { children, ...rest }: Omit<PageSectionsProps, 'divider' | 'stroke'> = $props();
</script>

<!-- Place once inside Surface. RecordGroup owns each logical section of the screen. -->
<PageSections {...rest} divider="hand-drawn" stroke="continuous" data-record-screen>
	{@render children()}
</PageSections>
{#if address && !daily}
	<p class="hidden print:block site-print-citation">
		{locale === 'fr' ? 'Source\u00a0: Transit.' : 'Source: Transit.'}
		{address}
	</p>
{/if}

<style>
	.site-print-citation {
		margin-block-start: var(--space-card-gap);
		overflow-wrap: anywhere;
		font-size: var(--text-small);
	}
</style>
