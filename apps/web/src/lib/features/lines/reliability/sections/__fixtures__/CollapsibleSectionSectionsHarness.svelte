<script lang="ts">
	import SectionsToggle from '#lib/components/shared/SectionsToggle.svelte';
	import CollapsibleSection from '../CollapsibleSection.svelte';

	const SECTIONS = [
		{
			dataSection: 'when-to-ride',
			title: 'By time of day',
			summary: 'Between 87% and 91% by period of the day. Lowest: Afternoon peak.',
		},
		{
			dataSection: 'the-wait',
			title: 'Waiting and gaps',
			summary: 'Waiting time is not measured here.',
		},
	] as const;
</script>

<SectionsToggle />
{#each SECTIONS as section (section.dataSection)}
	<CollapsibleSection {...section}>
		<p data-testid={`reliability-section-body-${section.dataSection}`}>Evidence</p>
	</CollapsibleSection>
{/each}
