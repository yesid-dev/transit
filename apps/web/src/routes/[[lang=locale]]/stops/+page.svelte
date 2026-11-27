<script lang="ts">
	import StopsIndex from '#lib/features/stops/StopsIndex.svelte';
	import { Surface } from '@yesid/ui/layout';
	import { page } from '$app/state';
	import { recoverReadings } from '#lib/features/record/recordRecovery.svelte.ts';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
	const readings = recoverReadings(
		() => data.finderRecord,
		({ period: { from, to }, city }) => ({
			screen: 'stops',
			from,
			to,
			city,
			lang: data.lang,
			// The list's own search and line choice: its readings follow the rows on screen.
			page: page.url.searchParams.toString(),
		}),
	);
</script>

<Surface>
	<StopsIndex
		locale={data.lang}
		record={readings() ?? null}
		listing={data.listing}
		view={data.view}
		provider={data.provider}
	/>
</Surface>
