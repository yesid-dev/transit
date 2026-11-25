<script lang="ts">
	import { PageSection, type PageSectionProps } from '@yesid/ui/layout';

	let {
		children,
		class: className,
		density,
		...rest
	}: PageSectionProps & { density?: 'compact' } = $props();
</script>

<!-- Keep the answer and its first cards in one group, and About these figures in the last. -->
<PageSection
	{...rest}
	class={[
		'grid min-w-0 grid-cols-1 gap-6 py-6 first:pt-0 last:pb-0 print:py-0',
		density === 'compact' && 'max-sm:gap-4',
		className,
	]}
>
	{@render children()}
</PageSection>
