<script lang="ts">
	import { page } from '$app/state';
	import type { Locale } from '#lib/i18n/index.ts';
	import type { ComponentProps } from 'svelte';
	import { agencyName, vehiclePositionsCapture } from '#lib/site/presenter.ts';
	import { overviewCopy } from '../home/overviewRecord.copy';
	import AboutFigures from './AboutFigures.svelte';

	let {
		locale,
		operator,
		healthLink,
		errorLink,
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
		errorLink?: string;
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
			label: locale === 'fr' ? 'Dernière collecte' : 'Last capture',
			text: captureText ?? vehiclePositionsCapture(captureAge, locale),
			links: [
				...(healthLink ? [{ href: healthLink, label: t.dataHealth }] : []),
				...(errorLink
					? [
							{
								href: errorLink,
								label: locale === 'fr' ? 'Vous avez vu une erreur?' : 'Seen an error?',
							},
						]
					: []),
			],
		},
		{
			key: 'source',
			label: t.source,
			text: operator ? t.liveFeeds(agencyName(operator, page.data.provider)) : null,
		},
	]}
/>
