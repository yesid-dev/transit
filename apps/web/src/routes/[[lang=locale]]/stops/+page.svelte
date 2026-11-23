<script lang="ts">
	import StopsIndex from '#lib/features/stops/StopsIndex.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
</script>

<StopsIndex record={data.finderRecord} />
