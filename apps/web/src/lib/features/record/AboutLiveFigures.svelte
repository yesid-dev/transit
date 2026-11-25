<script lang="ts">
	import type { Locale } from '#lib/i18n/index.ts';
	import { vehiclePositionsCapture } from '#lib/site/presenter.ts';
	import { overviewCopy } from '../home/overviewRecord.copy';
	import AboutFigures from './AboutFigures.svelte';

	let {
		locale,
		operator,
		healthLink,
		captureAge,
	}: {
		locale: Locale;
		operator?: string;
		healthLink: string;
		captureAge?: number | null;
	} = $props();
	const t = $derived(overviewCopy[locale]);
</script>

<AboutFigures
	title={t.aboutLive}
	fields={[
		{ key: 'shows', label: t.liveShows, text: t.liveScope },
		{ key: 'means', label: t.liveStatus, text: t.liveDefinition },
		{
			key: 'capture',
			label: locale === 'fr' ? 'Dernier relevé' : 'Last capture',
			text: vehiclePositionsCapture(captureAge, locale),
			link: { href: healthLink, label: t.dataHealth },
		},
		{ key: 'source', label: t.source, text: operator ? t.liveFeeds(operator) : null },
	]}
/>
