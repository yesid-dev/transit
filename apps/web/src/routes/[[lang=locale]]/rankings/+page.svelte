<script lang="ts">
	import { page } from '$app/state';
	import Rankings from '#lib/features/rankings/Rankings.svelte';
	import type { PageData } from './$types';
	let { data }: { data: PageData } = $props();
</script>

<Rankings
	record={data.record}
	locale={data.lang}
	url={new URL(page.url.href)}
	operator={data.provider?.labels[data.lang].operator}
/>
