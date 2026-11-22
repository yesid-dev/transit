<script lang="ts">
	import { page } from '$app/state';
	import Rankings from '#lib/features/rankings/Rankings.svelte';
	import type { PageData } from './$types';
	let { data }: { data: PageData } = $props();
</script>

<Rankings record={data} locale={data.lang} origin={page.url.origin} path="/repeat-offenders" />
