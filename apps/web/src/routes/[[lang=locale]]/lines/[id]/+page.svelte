<script lang="ts">
	import { page } from '$app/state';
	import { getLocale } from '#lib/i18n/index.ts';
	import LineRecord from '#lib/features/lines/LineRecord.svelte';
	import LineViewNav from '#lib/features/lines/LineViewNav.svelte';
	import RouteDetail from '#lib/features/lines/RouteDetail.svelte';
	import { lineRecordHeading, lineSubtitle } from '#lib/site/presenter.ts';
	import { transitDisplay } from '#lib/site/transitDisplayContext.ts';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
	const locale = getLocale();
	const display = transitDisplay();
	const name = $derived(display.lineName(data.seed.id));
	const routeType = $derived(display.directory.type(data.seed.id));
	const url = $derived(new URL(page.shallow?.url.href ?? page.url.href));
</script>

{#if data.record}
	<LineRecord
		name={data.seed.name}
		heading={lineRecordHeading(name, locale)}
		code={name.number}
		subtitle={lineSubtitle(
			routeType,
			data.directionHeadsigns,
			locale,
			display.directory.nameSeparators,
		)}
		scheduleOnly={data.scheduleOnly}
		{locale}
		{url}
		record={data.record}
		headsigns={data.directionHeadsigns}
		stopNames={data.stopNames}
		stopCodes={data.stopCodes}
		operator={data.provider?.labels[locale].operator ??
			data.v1?.manifest.display_name ??
			data.providerId}
	/>
{:else if data.frameLive && data.v1}
	{#if data.frameLive}<LineViewNav {url} {locale} view="live" />{/if}
	<RouteDetail id={data.seed.id} seed={data.seed} routeSeed={data.routeSeed ?? undefined} />
{/if}
