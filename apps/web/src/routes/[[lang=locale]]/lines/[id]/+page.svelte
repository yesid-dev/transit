<script lang="ts">
	import RecordScreen from '#lib/features/record/RecordScreen.svelte';
	import RecordGroup from '#lib/features/record/RecordGroup.svelte';
	import { page } from '$app/state';
	import { Surface } from '@yesid/ui/layout';
	import { getLocale, localizeHref } from '#lib/i18n/index.ts';
	import LineRecord from '#lib/features/lines/LineRecord.svelte';
	import LineLive from '#lib/features/lines/LineLive.svelte';
	import { lineViewHref } from '#lib/features/lines/lineRecordText.ts';
	import RecordAnswer from '#lib/features/record/RecordAnswer.svelte';
	import ScreenTitle from '#lib/features/record/ScreenTitle.svelte';
	import { recoverRecord } from '#lib/features/record/recordRecovery.svelte.ts';
	import { lineRecordHeading, lineSubtitle } from '#lib/site/presenter.ts';
	import { carryFrameState, frameHref } from '#lib/site/frameState.ts';
	import { transitDisplay } from '#lib/site/transitDisplayContext.ts';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
	const locale = getLocale();
	const display = transitDisplay();
	const name = $derived(display.lineName(data.seed.id));
	const routeType = $derived(display.directory.type(data.seed.id));
	const url = $derived(new URL(page.shallow?.url.href ?? page.url.href));
	const timetableNotice =
		locale === 'fr'
			? 'Cette ligne ne figure pas à l’horaire actuel.'
			: 'This line is not in the current timetable.';
	const subtitle = $derived(
		lineSubtitle(routeType, data.directionHeadsigns, locale, display.directory.nameSeparators),
	);
	const readings = recoverRecord(
		() => data.record,
		({ city, line, direction, period }) => ({ ...period, city, id: line, direction, kind: 'line' }),
	);
	const record = $derived(readings());
	const operator = $derived(data.provider?.labels[locale].operator ?? data.providerId);
	const back = $derived.by(() => {
		const contentUrl =
			!data.frameLive && record
				? new URL(
						frameHref(url, { mode: 'record', period: { ...record.period, preset: null } }),
						url,
					)
				: url;
		const lines = localizeHref('/lines', locale, data.providerId);
		return {
			href: carryFrameState(lines, contentUrl),
			label: locale === 'fr' ? 'Toutes les lignes' : 'All lines',
		};
	});
</script>

<Surface>
	<RecordScreen>
		<RecordGroup>
			<ScreenTitle
				id="line-title"
				title={lineRecordHeading(name, locale)}
				plate={name.number ?? undefined}
				subtitle={subtitle ?? (data.outsideCurrentTimetable ? timetableNotice : undefined)}
				hideSubtitle={data.frameLive && data.outsideCurrentTimetable && !subtitle}
				{back}
			/>
		</RecordGroup>
		{#if data.frameLive && data.outsideCurrentTimetable}
			<RecordGroup
				><div data-slot="screen-content">
					<div id="line-detail-profile" data-slot="screen-answer">
						<RecordAnswer {locale} value={null} state="no_live_data" sentence={timetableNotice}>
							{#snippet actions()}
								<a
									class="inline-flex min-h-11 items-center text-primary underline"
									href={lineViewHref(url, 'record').href}
								>
									{locale === 'fr' ? 'Voir le bilan' : 'View record'}
								</a>
							{/snippet}
						</RecordAnswer>
					</div>
				</div></RecordGroup
			>
		{:else if data.frameLive}
			{#key data.capture ?? data.seed.id}
				<LineLive
					line={data.seed.id}
					name={data.seed.name}
					city={data.providerId}
					{locale}
					{url}
					{operator}
					timeZone={data.provider?.timezone ?? 'UTC'}
					scheduleOnly={data.scheduleOnly}
					knownLine={data.knownLine}
					hasAlerts={data.hasAlerts}
					mainStops={data.mainStops}
					capture={data.capture}
					trips={data.trips}
					{record}
					stopNames={data.stopNames}
					headsigns={data.directionHeadsigns}
				/>
			{/key}
		{:else if record}
			<LineRecord
				name={data.seed.name}
				scheduleOnly={data.scheduleOnly}
				{locale}
				{url}
				{record}
				headsigns={data.directionHeadsigns}
				stopNames={data.stopNames}
				stopCodes={data.stopCodes}
				{operator}
			/>
		{/if}
	</RecordScreen>
</Surface>
