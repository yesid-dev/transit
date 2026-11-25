<script lang="ts">
	import StopsIndex from '#lib/features/stops/StopsIndex.svelte';
	import { Surface } from '@yesid/ui/layout';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
</script>

<Surface>
	<StopsIndex
		locale={data.lang}
		record={data.finderRecord}
		listing={data.listing}
		view={data.view}
		provider={data.provider}
	/>
</Surface>
