<script lang="ts">
	import type { Locale } from '#lib/i18n/index.ts';
	import type { ComponentProps } from 'svelte';
	import { vehiclePositionsCapture } from '#lib/site/presenter.ts';
	import { overviewCopy } from '../home/overviewRecord.copy';
	import AboutFigures from './AboutFigures.svelte';

	let {
		locale,
		operator,
		healthLink,
		captureAge,
		scope,
		statusLabel,
		definition,
		captureText,
		additionalFields = [],
		edge,
		interactive,
	}: {
		locale: Locale;
		operator?: string;
		healthLink?: string;
		captureAge?: number | null;
		scope?: string;
		statusLabel?: string;
		definition?: string;
		captureText?: string;
		additionalFields?: ComponentProps<typeof AboutFigures>['fields'];
		edge?: 'brand' | 'neutral';
		interactive?: boolean;
	} = $props();
	const t = $derived(overviewCopy[locale]);
</script>

<AboutFigures
	title={t.aboutLive}
	{edge}
	{interactive}
	fields={[
		{ key: 'shows', label: t.liveShows, text: scope ?? t.liveScope },
		{ key: 'means', label: statusLabel ?? t.liveStatus, text: definition ?? t.liveDefinition },
		...additionalFields,
		{
			key: 'capture',
			label: locale === 'fr' ? 'Dernier relevé' : 'Last capture',
			text: captureText ?? vehiclePositionsCapture(captureAge, locale),
			link: healthLink ? { href: healthLink, label: t.dataHealth } : undefined,
		},
		{ key: 'source', label: t.source, text: operator ? t.liveFeeds(operator) : null },
	]}
/>
