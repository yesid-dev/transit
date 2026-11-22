<script lang="ts">
	import { SvelteURL } from 'svelte/reactivity';
	import { Card } from '@yesid/ui/card';
	import { Surface } from '@yesid/ui/layout';
	import { localizeHref, type Locale } from '#lib/i18n/index.ts';
	import CopyAction from '#lib/features/hotspots/sections/CopyAction.svelte';
	import RecordPending from '#lib/features/record/RecordPending.svelte';
	import { dateRange } from '#lib/features/record/recordText.ts';
	import type { loadLineRecord, LineSection } from '#lib/server/lineRecord.ts';
	import { carryFrameState, frameHref } from '#lib/site/frameState.ts';
	import type { RouteFile } from '#lib/v1/schemas/route.ts';
	import { directionHeadsigns } from './directions.ts';
	import LineRecordReadings from './LineRecordReadings.svelte';
	import LineViewNav from './LineViewNav.svelte';
	import {
		choose,
		directionLabel,
		lineCitation,
		lineSectionTitles,
		lineViewHref,
		recordMessage,
	} from './lineRecordText.ts';

	let {
		name,
		locale,
		url,
		record,
		metadata,
	}: {
		name: string;
		locale: Locale;
		url: URL;
		record: ReturnType<typeof loadLineRecord>;
		metadata: Promise<RouteFile | null>;
	} = $props();

	let routeFile = $state<RouteFile | null>(null);
	$effect(() => {
		const pending = metadata;
		let current = true;
		routeFile = null;
		void pending.then((file) => {
			if (current) routeFile = file;
		});
		return () => {
			current = false;
		};
	});
	const directions = [null, '0', '1'] as const;
	const headsigns = $derived(directionHeadsigns(routeFile?.directions));
	const stopNames = $derived(
		new Map(
			routeFile?.directions?.flatMap((direction) =>
				(direction.stops ?? []).flatMap((stop) =>
					stop.name ? [[stop.id, stop.name] as const] : [],
				),
			) ?? [],
		),
	);
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

	function share(section: LineSection) {
		const link = new SvelteURL(pinned);
		link.hash = section;
		return link.href;
	}

	function csv(section: LineSection) {
		const link = new SvelteURL(pinned);
		link.pathname = `${link.pathname.replace(/\/$/, '')}/record.csv`;
		link.hash = '';
		link.searchParams.delete('tab');
		link.searchParams.set('section', section);
		return link.pathname + link.search;
	}
</script>

<Surface>
	<div class="grid min-w-0 gap-4">
		<header class="grid gap-2">
			<a href={back}>{t('All lines', 'Toutes les lignes')}</a>
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
			<Card edge="neutral" textSize="inherit" class="min-w-0 px-4 sm:px-6">
				<section id={section} aria-labelledby={`${section}-title`} class="grid min-w-0 gap-3">
					<h2 id={`${section}-title`}>{title}</h2>
					{#await answer}
						{#key answer}<RecordPending {locale} />{/key}
					{:then result}
						{@const message = recordMessage(result, locale)}
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
								/>
							{/if}
							{#if result.answer.coverage_note}<p>{result.answer.coverage_note[locale]}</p>{/if}
							{#key share(section)}
								<div class="flex flex-wrap items-start gap-x-4 gap-y-2">
									<CopyAction
										text={share(section)}
										label={t('Copy link', 'Copier le lien')}
										done={t('Link copied.', 'Lien copié.')}
										fallback={t('Copy the link below.', 'Copiez le lien ci-dessous.')}
										fallbackLabel={t('Link to this section', 'Lien vers cette section')}
									/>
									<a
										class="inline-flex min-h-11 items-center"
										href={csv(section)}
										download
										aria-label={t(`Download CSV for ${title}`, `Télécharger le CSV pour ${title}`)}
										>CSV</a
									>
									<details class="min-w-0">
										<summary class="min-h-11 cursor-pointer py-3">{t('Cite', 'Citer')}</summary>
										<p class="break-all">
											{lineCitation(name, title, result.answer, locale, share(section))}
										</p>
									</details>
								</div>
							{/key}
						{/if}
					{/await}
				</section>
			</Card>
		{/each}
	</div>
</Surface>
