<script lang="ts">
	import type { Locale } from '#lib/i18n/index.ts';
	import { choose } from '#lib/features/record/recordText.ts';
	import { stopViewHref } from '#lib/site/stopFrame.ts';

	let { url, locale, view }: { url: URL; locale: Locale; view: 'record' | 'live' } = $props();
	const views = $derived([
		{ id: 'record', label: choose(locale, 'Record', 'Bilan') },
		{ id: 'live', label: choose(locale, 'Live now', 'En direct') },
	] as const);
</script>

<nav aria-label={choose(locale, 'Stop views', 'Vues de l’arrêt')} class="flex flex-wrap gap-x-4">
	{#each views as item (item.id)}
		<a
			class="inline-flex min-h-11 min-w-11 items-center"
			aria-current={view === item.id ? 'page' : undefined}
			href={stopViewHref(url, item.id).href}>{item.label}</a
		>
	{/each}
</nav>
