<script lang="ts">
	import { page } from '$app/state';
	import Rankings from '#lib/features/rankings/Rankings.svelte';
	import { recoverReadings } from '#lib/features/record/recordRecovery.svelte.ts';
	import type { PageData } from './$types';
	let { data }: { data: PageData } = $props();
	const readings = recoverReadings(
		() => data.record,
		({ period, city }) =>
			period
				? {
						screen: 'rankings',
						from: period.from,
						to: period.to,
						city,
						// The ranking chosen in the address: kind, measure and class.
						page: page.url.searchParams.toString(),
					}
				: null,
	);
	const record = $derived(readings() ?? data.record);
</script>

<Rankings
	{record}
	locale={data.lang}
	url={new URL(page.url.href)}
	operator={data.provider?.labels[data.lang].operator}
/>
