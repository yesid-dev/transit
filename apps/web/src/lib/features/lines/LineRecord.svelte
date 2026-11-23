<script lang="ts">
	import { Card } from '@yesid/ui/card';
	import { Surface } from '@yesid/ui/layout';
	import { localizeHref, type Locale } from '#lib/i18n/index.ts';
	import RecordActions from '#lib/features/record/RecordActions.svelte';
	import { recordSectionLinks } from '#lib/features/record/recordLinks.ts';
	import RecordPending from '#lib/features/record/RecordPending.svelte';
	import {
		choose,
		dateRange,
		lastGoodNote,
		recordMessage,
	} from '#lib/features/record/recordText.ts';
	import type { loadLineRecord } from '#lib/server/lineRecord.ts';
	import { carryFrameState, frameHref } from '#lib/site/frameState.ts';
	import LineRecordReadings from './LineRecordReadings.svelte';
	import LineViewNav from './LineViewNav.svelte';
	import {
		directionLabel,
		lineCitation,
		lineSectionTitles,
		lineViewHref,
	} from './lineRecordText.ts';

	let {
		name,
		locale,
		url,
		record,
		headsigns,
		stopNames: stopNamesById,
	}: {
		name: string;
		locale: Locale;
		url: URL;
		record: ReturnType<typeof loadLineRecord>;
		headsigns: Record<number, string>;
		stopNames: Record<string, string>;
	} = $props();

	const directions = [null, '0', '1'] as const;
	const stopNames = $derived(new Map(Object.entries(stopNamesById)));
	const t = (en: string, fr: string) => choose(locale, en, fr);
	const pinned = $derived.by(() => {
		const link = lineViewHref(url, record.view, record.direction);
		link.searchParams.set('provider', record.city);
		return new URL(
			frameHref(link, { mode: 'record', period: { ...record.period, preset: null } }),
			url,
		);
	});
	const back = $derived(carryFrameState(localizeHref('/lines', locale, record.city), pinned));
</script>

<Surface>
	<div class="grid min-w-0 gap-4">
		<header class="grid gap-2">
			<a class="inline-flex min-h-11 w-fit items-center" href={back}>
				{t('All lines', 'Toutes les lignes')}
			</a>
			<h1>{name}</h1>
			<LineViewNav url={pinned} {locale} view={record.view} />
			<p>{dateRange(record.period, locale)}</p>
			<nav
				aria-label={t('Filter by direction', 'Filtrer par direction')}
				class="flex flex-wrap gap-x-4"
			>
				{#each directions as direction (direction)}
					<a
						href={lineViewHref(pinned, record.view, direction).href}
						class="inline-flex min-h-11 items-center"
						aria-current={direction === record.direction ? 'true' : undefined}
					>
						{direction === null
							? t('Both directions', 'Les deux directions')
							: directionLabel(direction, headsigns, locale)}
					</a>
				{/each}
			</nav>
		</header>

		{#each record.sections as { section, answer } (section)}
			{@const title = t(...lineSectionTitles[section])}
			{@const links = recordSectionLinks(pinned, section)}
			<Card edge="neutral" textSize="inherit" class="min-w-0 px-4 sm:px-6">
				<section id={section} aria-labelledby={`${section}-title`} class="grid min-w-0 gap-3">
					<h2 id={`${section}-title`}>{title}</h2>
					{#await answer}
						{#key answer}<RecordPending {locale} />{/key}
					{:then result}
						{@const message = recordMessage(result, locale)}
						{#if result.kind === 'answer' && result.lastGood}<p>{lastGoodNote[locale]}</p>{/if}
						{#if message}<p>{message}</p>{/if}
						{#if result.kind === 'answer'}
							{#if !message}
								<LineRecordReadings
									answer={result.answer}
									{section}
									{locale}
									{title}
									{headsigns}
									{stopNames}
									url={pinned}
									line={record.line}
									city={record.city}
									direction={record.direction}
								/>
							{/if}
							{#if result.answer.coverage_note}<p>{result.answer.coverage_note[locale]}</p>{/if}
							<RecordActions
								{locale}
								{title}
								href={links.share}
								csv={links.csv}
								citation={lineCitation(name, title, result.answer, locale, links.share)}
							/>
						{/if}
					{/await}
				</section>
			</Card>
		{/each}
	</div>
</Surface>
