<script lang="ts">
	import type { ComponentProps } from 'svelte';
	import RecordPatience from './RecordPatience.svelte';
	import RecordRecoveryHarness from './RecordRecoveryHarness.svelte';

	let props: ComponentProps<typeof RecordRecoveryHarness> = $props();
</script>

<RecordPatience locale="en" period={{ from: '2026-11-17', to: '2026-11-23' }} scope={props.scope}>
	<RecordRecoveryHarness {...props} />
</RecordPatience>
