<script lang="ts">
	import { PageSection, type PageSectionProps } from '@yesid/ui/layout';

	let { children, class: className, ...rest }: PageSectionProps = $props();
</script>

<!-- Keep the answer and its first cards in one group, and About these figures in the last. -->
<PageSection
	{...rest}
	class={['min-w-0 grid-cols-1 py-6 first:pt-0 last:pb-0 print:py-0', className]}
>
	{@render children()}
</PageSection>
