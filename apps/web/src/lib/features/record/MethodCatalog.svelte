<script lang="ts">
	import { Button } from '@yesid/ui/button';
	import { Surface } from '@yesid/ui/layout';
	import { sectionsToggleCopy } from '#lib/components/shared/sectionsToggle.copy.ts';
	import { localizeHref, type Locale } from '#lib/i18n/index.ts';
	import type { EngineResult, MethodEntry } from '#lib/server/engine.ts';
	import { frameHref } from '#lib/site/frameState.ts';
	import {
		longDate,
		methodEvidence,
		registryUnitText,
		versionNumber,
	} from '#lib/site/presenter.ts';
	import type { DateWindow } from '#lib/v1/history/window.ts';
	import RecordActionGroup from './RecordActionGroup.svelte';
	import RecordAnswer from './RecordAnswer.svelte';
	import RecordCard from './RecordCard.svelte';
	import RecordPending from './RecordPending.svelte';
	import ScreenTitle from './ScreenTitle.svelte';
	import StateMark from './StateMark.svelte';
	import { methodCopy, methodReferenceStates } from './methodCatalog.copy.ts';
	import { methodGroups, methodName, methodParts, methodSummary } from './methodCatalogText';
	import { recordSectionLinks } from './recordLinks.ts';
	import { choose, lastGoodNote, recordConnection, tally } from './recordText.ts';

	let {
		catalog,
		locale,
		url,
		city,
		period,
		cleaningVersion,
	}: {
		catalog: Promise<EngineResult<MethodEntry[]>>;
		locale: Locale;
		url: URL;
		city: string;
		period: DateWindow | null;
		cleaningVersion?: number;
	} = $props();

	const copy = $derived(methodCopy[locale]);
	const rangeFields = ['counts', 'exclusions', 'limits'] as const;
	const title = $derived(choose(locale, 'How we measure', 'Comment on mesure'));
	const canonical = $derived(new URL(url.pathname, url));
	const csvScope = $derived.by(() => {
		const selected = new URL(canonical);
		selected.searchParams.set('provider', city);
		return new URL(
			frameHref(selected, { mode: 'record', period: period && { ...period, preset: null } }),
			url,
		);
	});
	let measures = $state<HTMLElement>();
	let hasOpenCards = $state(false);
	const cards = 'details[data-record-disclosure]';

	function revealMeasure(node: HTMLElement, hash: string) {
		const target = document.getElementById(hash.slice(1));
		if (!target || !node.contains(target)) return;
		let details = target.closest<HTMLDetailsElement>(cards);
		while (details) {
			details.open = true;
			details = details.parentElement?.closest<HTMLDetailsElement>(cards) ?? null;
		}
		const frame = requestAnimationFrame(() => target.scrollIntoView({ block: 'start' }));
		return () => cancelAnimationFrame(frame);
	}

	$effect(() => {
		if (measures) return revealMeasure(measures, url.hash);
	});

	$effect(() => {
		const node = measures;
		if (!node) return;
		const sync = () => {
			hasOpenCards = !!node.querySelector(`${cards}[open]:not(details:not([open]) *)`);
		};
		sync();
		// Native toggle events also cover keyboard, fragment and find-in-page reveals.
		node.addEventListener('toggle', sync, true);
		return () => node.removeEventListener('toggle', sync, true);
	});

	function toggleAll() {
		if (!measures) return;
		const open = !hasOpenCards;
		for (const card of measures.querySelectorAll<HTMLDetailsElement>(
			open ? cards : 'details[open]',
		))
			card.open = open;
		hasOpenCards = open;
	}

	function versions(entries: MethodEntry[], cleaningVersion?: number) {
		const measure = entries.find(({ id }) => id === 'on_time');
		if (!measure) return undefined;
		return methodEvidence(
			{
				method_version: measure.method_version,
				cleaning_versions: cleaningVersion === undefined ? undefined : [cleaningVersion],
			},
			locale,
			true,
		);
	}
</script>

{#snippet measure(
	entry: MethodEntry,
	byId: Map<string, MethodEntry>,
	details: ReturnType<typeof methodParts>[string],
	nested = false,
)}
	<RecordCard
		title={methodName(entry, locale)}
		disclosure={{
			id: entry.id,
			description: methodSummary(entry, locale),
			nested,
			initiallyOpen: entry.id === 'on_time',
		}}
	>
		<dl class="method-parts">
			{#each details.parts as part (part.field)}
				<div>
					<dt>{copy[part.field]}</dt>
					{#if part.lead}<dd>{part.lead}</dd>{/if}
					{#each part.shared as owner (owner)}
						<dd>
							<a class="method-link" href={'#' + owner}>{methodName(byId.get(owner)!, locale)}</a>
						</dd>
					{/each}
					{#if !part.lead && !part.shared.length}<dd>{copy.missing}</dd>{/if}
					{#if part.field === 'limits' && entry.minimum_sample > 0}
						<dd>
							{copy.minimum}{locale === 'fr' ? ' : ' : ': '}{tally(entry.minimum_sample, locale)}
						</dd>
					{/if}
					{#if part.field === 'limits' && entry.ranking_minimum_sample}
						<dd>
							{copy.rankingMinimum}{locale === 'fr' ? ' : ' : ': '}{tally(
								entry.ranking_minimum_sample,
								locale,
							)}
						</dd>
					{/if}
				</div>
			{/each}
			<div>
				<dt>{copy.since}</dt>
				<dd>
					{versionNumber(entry.method_version)},
					<time datetime={entry.since}>{longDate(entry.since, locale)}</time>
				</dd>
			</div>
		</dl>
		{#if details.definition || details.parts.some(({ notes }) => notes)}
			<details class="mt-3">
				<summary class="min-h-11 cursor-pointer py-3">{copy.notes}</summary>
				{#if details.definition}<p class="mb-3">{details.definition}</p>{/if}
				<dl class="method-parts">
					{#each details.parts as part (part.field)}
						{#if part.notes}<div>
								<dt>{copy[part.field]}</dt>
								<dd>{part.notes}</dd>
							</div>{/if}
					{/each}
				</dl>
			</details>
		{/if}
	</RecordCard>
{/snippet}

{#snippet group(
	group: ReturnType<typeof methodGroups>['groups'][number],
	byId: Map<string, MethodEntry>,
	details: ReturnType<typeof methodParts>,
)}
	{#if group.entries.length === 1}
		{@const entry = group.entries[0]}
		{@render measure(entry, byId, details[entry.id])}
	{:else}
		<RecordCard title={group.name} disclosure={{ id: group.id, description: group.summary }}>
			<div class="grid min-w-0 gap-3">
				{#each group.entries as entry (entry.id)}
					{@render measure(entry, byId, details[entry.id], true)}
				{/each}
			</div>
		</RecordCard>
	{/if}
{/snippet}

{#snippet actions(entries: MethodEntry[])}
	{#snippet citations()}
		<ul class="grid gap-2">
			{#each entries as entry (entry.id)}
				{@const share = recordSectionLinks(canonical, entry.id).share}
				<li>
					Transit. {title}. {entry.text[locale].definition} ({versionNumber(entry.method_version)}, {longDate(
						entry.since,
						locale,
					)}).
					{#each share.split(/(?<=[/?&=#_.:%-])/u) as part, index (index)}{part}<wbr />{/each}
				</li>
			{/each}
		</ul>
	{/snippet}
	<RecordActionGroup
		{locale}
		href={canonical.href}
		citation={citations}
		files={entries
			.filter((entry) => entry.csv_columns[locale].length)
			.map((entry) => ({
				href: period ? recordSectionLinks(csvScope, entry.id).csv : undefined,
				label: methodName(entry, locale),
				columns: entry.csv_columns[locale].map((column) => registryUnitText(column, locale)),
			}))}
	/>
{/snippet}

<Surface>
	<div class="grid min-w-0 gap-6">
		<ScreenTitle {title} />
		<div
			data-slot="screen-content"
			class="method-content grid min-w-0 gap-6 border-t border-border pt-4"
		>
			{#await catalog}
				<div data-slot="screen-state">
					{#key catalog}<RecordPending {locale} answer={catalog} />{/key}
				</div>
			{:then result}
				{#if result.kind !== 'answer'}
					<div data-slot="screen-state">
						{#if result.kind === 'busy'}<RecordPending {locale} busy />
						{:else}<RecordAnswer
								value={null}
								sentence={recordConnection[result.kind][locale]}
								{locale}
							/>{/if}
					</div>
				{:else}
					{@const { groups, extra } = methodGroups(result.answer, locale)}
					{@const ordered = [...groups, ...extra].flatMap(({ entries }) => entries)}
					{@const parts = methodParts(ordered, locale)}
					{@const byId = new Map(ordered.map((entry) => [entry.id, entry]))}
					{@const version = versions(result.answer, cleaningVersion)}
					<div data-slot="screen-answer">
						{#snippet leadActions()}{@render actions(result.answer)}{/snippet}
						{#snippet meta()}{#if version}<p>{version}</p>{/if}{/snippet}
						<RecordAnswer
							value={null}
							sentence={copy.intro}
							{locale}
							actions={result.answer.length ? leadActions : undefined}
							{meta}
						/>
					</div>
					{#if result.lastGood}<p>{lastGoodNote[locale]}</p>{/if}
					{#if !result.answer.length}
						<p>
							{choose(
								locale,
								'No measures are listed yet.',
								'Aucune mesure n’est encore répertoriée.',
							)}
						</p>
					{:else}
						<p class="text-muted-foreground">
							{copy.files}
							<a class="method-link" href={localizeHref('/download', locale, city)}
								>{copy.downloadPage}</a
							>
							{copy.cleanTables}
						</p>
					{/if}
					<section class="grid min-w-0 gap-6" aria-labelledby="method-heading" bind:this={measures}>
						<header class="flex flex-wrap items-center justify-between gap-3">
							<h2 id="method-heading">{copy.heading}</h2>
							{#if ordered.length}
								<Button variant="outline" size="sm" class="min-h-11" onclick={toggleAll}
									>{hasOpenCards
										? sectionsToggleCopy[locale].collapse
										: sectionsToggleCopy[locale].expand}</Button
								>
							{/if}
						</header>
						{#each groups as item (item.id)}{@render group(item, byId, parts)}{/each}
						<RecordCard
							title={copy.range.title}
							disclosure={{ id: 'ranking-range', description: copy.range.summary }}
						>
							<dl class="method-parts">
								{#each rangeFields as field (field)}
									<div>
										<dt>{copy[field]}</dt>
										<dd>{copy.range[field]}</dd>
									</div>
								{/each}
								<div>
									<dt>{copy.since}</dt>
									<dd>{copy.missing}</dd>
								</div>
							</dl>
						</RecordCard>
						<RecordCard title={copy.statesTitle}>
							<dl class="method-parts">
								{#each methodReferenceStates as state (state)}
									<div>
										<dt><StateMark {state} {locale} /></dt>
										<dd>{copy.states[state]}</dd>
									</div>
								{/each}
							</dl>
							<p class="mt-4 text-muted-foreground">{copy.statesNote}</p>
						</RecordCard>
						<RecordCard title={copy.limitsTitle}>
							<ul class="method-limits list-outside list-disc">
								{#each copy.recordLimits as line (line)}<li>{line}</li>{/each}
							</ul>
						</RecordCard>
						{#if extra.length}
							<section aria-labelledby="more-methods" class="grid min-w-0 gap-4">
								<h2 id="more-methods">{copy.more}</h2>
								{#each extra as item (item.id)}{@render group(item, byId, parts)}{/each}
							</section>
						{/if}
					</section>
				{/if}
			{/await}
			<a
				class="method-link inline-flex min-h-11 items-center justify-self-start"
				href={localizeHref('/metrics/archive', locale, city)}>{copy.archive}</a
			>
		</div>
	</div>
</Surface>

<style>
	.method-content {
		overflow-wrap: normal;
		word-break: normal;
	}
	.method-parts,
	.method-limits {
		display: grid;
		gap: var(--space-card-gap);
	}
	h2,
	dt {
		font-weight: 600;
	}
	h2 {
		font-size: var(--text-subheading);
	}
	dt {
		color: var(--muted-foreground);
	}
	.method-link {
		color: var(--primary);
		text-decoration: underline;
	}
	summary:focus-visible {
		outline: 2px solid var(--ring);
		outline-offset: 2px;
	}
	@media (min-width: 64rem) {
		.method-parts {
			grid-template-columns: repeat(3, minmax(0, 1fr));
		}
		.method-limits {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
	}
</style>
