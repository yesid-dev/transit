<script lang="ts">
	import type { Locale } from '#lib/i18n/index.ts';
	import { choose } from '#lib/features/record/recordText.ts';
	import { lineViewHref } from './lineRecordText.ts';

	let { url, locale, view }: { url: URL; locale: Locale; view: 'record' | 'schedule' | 'live' } =
		$props();
	const views = $derived([
		{ id: 'record', label: choose(locale, 'Record', 'Bilan') },
		{ id: 'live', label: choose(locale, 'Live now', 'En direct') },
		{ id: 'schedule', label: choose(locale, 'Schedule', 'Horaire') },
	] as const);
</script>

<nav aria-label={choose(locale, 'Line views', 'Vues de la ligne')} class="flex flex-wrap gap-x-4">
	{#each views as item (item.id)}
		<a
			class="inline-flex min-h-11 items-center"
			aria-current={view === item.id ? 'page' : undefined}
			href={lineViewHref(url, item.id).href}>{item.label}</a
		>
	{/each}
</nav>
