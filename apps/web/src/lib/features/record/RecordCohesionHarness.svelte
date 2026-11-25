<script lang="ts">
	import RecordScreen from './RecordScreen.svelte';
	import RecordGroup from './RecordGroup.svelte';
	import RecordCard from './RecordCard.svelte';
	import FactList from './FactList.svelte';
	import FactRow from './FactRow.svelte';
</script>

<RecordScreen>
	<RecordGroup><h1>Screen title</h1></RecordGroup>
	<RecordGroup>
		<RecordCard title="Summary" interactive>
			<FactList>
				<FactRow label="Median delay">2 min</FactRow>
				<FactRow label="90th percentile">7 min</FactRow>
			</FactList>
			{#snippet footer()}<a href="/network">Network record</a>{/snippet}
		</RecordCard>
	</RecordGroup>
	<RecordGroup>
		<RecordCard title="About these figures">
			<p>Seven days of observations.</p>
		</RecordCard>
	</RecordGroup>
</RecordScreen>
