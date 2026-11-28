<script lang="ts">
	import { isSettled, whenAll, type Awaitable } from '#lib/site/ready.ts';
	import { onMount, untrack, type Snippet } from 'svelte';
	import { afterNavigate } from '$app/navigation';
	import { ChevronToggle, HeadingPermalink, useSectionJump, type TocEntry } from '@yesid/ui/brand';
	import { Button } from '@yesid/ui/button';
	import * as Collapsible from '@yesid/ui/collapsible';
	import { sections } from '@yesid/ui/state';
	import RecordScreen from './RecordScreen.svelte';
	import RecordGroup from './RecordGroup.svelte';
	import { ArticleHeader, DetailFrame } from '@yesid/ui/layout';
	import { sectionsToggleCopy } from '#lib/components/shared/sectionsToggle.copy.ts';
	import { localizeHref, type Locale } from '#lib/i18n/index.ts';
	import type { EngineResult, MethodEntry } from '#lib/server/engine.ts';
	import { frameHref } from '#lib/site/frameState.ts';
	import { longDate, pageCitation, registryUnitText, versionNumber } from '#lib/site/presenter.ts';
	import type { DateWindow } from '#lib/v1/history/window.ts';
	import RecordActionGroup from './RecordActionGroup.svelte';
	import CiteBlock from './CiteBlock.svelte';
	import RecordAnswer from './RecordAnswer.svelte';
	import RecordPending from './RecordPending.svelte';
	import StateMark from './StateMark.svelte';
	import { methodCopy, methodReferenceStates } from './methodCatalog.copy.ts';
	import {
		buildMethodViews,
		dataUserFields,
		methodGroups,
		methodName,
		sameAsName,
		type DataUserNote,
		type FieldPart,
		type GroupView,
	} from './methodCatalogText';
	import { recordSectionLinks } from './recordLinks.ts';
	import { choose, lastGoodNote, recordConnection, tally } from './recordText.ts';

	let {
		catalog,
		locale,
		url,
		city,
		period,
	}: {
		catalog: Awaitable<EngineResult<MethodEntry[]>>;
		locale: Locale;
		url: URL;
		city: string;
		period: DateWindow | null;
	} = $props();

	const copy = $derived(methodCopy[locale]);
	const catalogue = $derived.by(() => {
		const language = locale;
		return whenAll([catalog], ([result]) => ({
			result,
			...(result.kind === 'answer'
				? methodGroups(result.answer, language)
				: { groups: [], extra: [] }),
		}));
	});
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
	const navigation = useSectionJump(afterNavigate);
	let activeId = $state('method-heading');
	let methodList = $state<HTMLElement>();
	let extraHeading = $state<HTMLHeadingElement>();
	let reading = $state<HTMLElement>();
	let openCards = $state<Record<string, boolean>>({});
	let bulkOpen = $state<boolean>();
	let ready = $state(false);
	const referenceSections = ['ranking-range', 'about-transit'];
	const isOpen = (id: string, independent = false) =>
		openCards[id] ?? (!independent && (bulkOpen ?? id === 'on_time'));

	onMount(() => {
		const { sectionsSaved, sectionsChoice } = document.documentElement.dataset;
		if (sectionsSaved !== undefined) bulkOpen = sectionsChoice === 'expanded';
		ready = true;
	});

	function revealMethod(id: string) {
		let disclosure = document.getElementById(id)?.closest<HTMLElement>('.method-disclosure');
		while (disclosure && reading?.contains(disclosure)) {
			openCards[disclosure.dataset.methodDisclosure!] = true;
			disclosure = disclosure.parentElement?.closest<HTMLElement>('.method-disclosure');
		}
	}

	function setAll(next: boolean) {
		bulkOpen = next;
		openCards = Object.fromEntries(
			Object.entries(openCards).filter(([id]) => id.endsWith('-notes')),
		);
		if (next) sections.expandAll();
		else sections.collapseAll();
	}

	$effect(() => {
		const id = url.hash.slice(1);
		if (reading && id && (methodList || document.getElementById(id))) {
			// Follow the fragment on navigation and when the catalogue arrives.
			void untrack(() => navigation.jump(id, { beforeReveal: revealMethod, behavior: 'auto' }));
		}
	});
	const summaryKey = (text: string) =>
		text
			.normalize('NFC')
			.trim()
			.replace(/[.!?]+$/u, '')
			.toLocaleLowerCase(locale);
	const contentsLabel = $derived(choose(locale, 'On this page', 'Sur cette page'));
	const permalinkLabel = $derived(
		choose(locale, 'Link to this section', 'Lien vers cette section'),
	);
	const hasMore = $derived(isSettled(catalogue) ? catalogue.extra.length > 0 : !!extraHeading);
	const railEntries: TocEntry[] = $derived([
		{ id: 'method-heading', title: copy.heading, level: 2, children: [] },
		{ id: 'more-methods', title: copy.more, level: 2, children: [] },
		{ id: 'ranking-range', title: copy.range.title, level: 2, children: [] },
		{ id: 'reading-states', title: copy.statesTitle, level: 2, children: [] },
		{ id: 'record-limits-heading', title: copy.limitsTitle, level: 2, children: [] },
		{ id: 'about-transit', title: copy.about.title, level: 2, children: [] },
	]);
	const entries = $derived(railEntries.filter(({ id }) => id !== 'more-methods' || hasMore));
</script>

{#snippet methodSection(
	id: string,
	name: string,
	details: Snippet,
	description?: string,
	independent = false,
	level: 2 | 3 | 4 = 3,
)}
	{@const expanded = isOpen(id, independent)}
	{@const summary =
		description && summaryKey(description) !== summaryKey(name) ? description : null}
	<Collapsible.Root
		class="method-disclosure"
		data-method-disclosure={id}
		data-method-bulk={independent ? undefined : ''}
		open={expanded}
		onOpenChange={(value) => (openCards[id] = value)}
	>
		<svelte:element
			this={`h${level}`}
			{id}
			aria-labelledby={id + '-title'}
			class="method-anchor method-disclosure-heading section-title"
		>
			<HeadingPermalink target={id} label={permalinkLabel} />
			<Collapsible.Trigger
				aria-describedby={summary ? id + '-summary' : undefined}
				class="method-disclosure-trigger inline-flex min-h-11 max-w-full items-start gap-2 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
			>
				<span id={id + '-title'} class="min-w-0">{name}</span>
				<ChevronToggle open={expanded} direction="right" class="shrink-0 print:hidden" />
			</Collapsible.Trigger>
		</svelte:element>
		{#if summary}<p id={id + '-summary'} data-slot="section-summary">{summary}</p>{/if}
		<Collapsible.Content>
			<div class="min-w-0 pt-2">
				{@render details()}
			</div>
		</Collapsible.Content>
	</Collapsible.Root>
{/snippet}

{#snippet measuresHeading(ids: readonly string[] = referenceSections)}
	{@const expanded = ids.some((id) => isOpen(id))}
	{@const toggleCopy = sectionsToggleCopy[locale]}
	<div class="method-heading-row flex min-w-0 flex-wrap items-center justify-between gap-3">
		<h2 id="method-heading" aria-labelledby="method-heading-title" class="section-title">
			<HeadingPermalink target="method-heading" label={permalinkLabel} />
			<span id="method-heading-title">{copy.heading}</span>
		</h2>
		<div class="min-h-11 print:hidden">
			<Button
				variant="outline"
				size="cta-sm"
				wrap
				class="min-h-11"
				title={expanded ? toggleCopy.collapseTitle : toggleCopy.expandTitle}
				onclick={() => setAll(!expanded)}
				>{expanded ? toggleCopy.collapse : toggleCopy.expand}</Button
			>
		</div>
	</div>
{/snippet}

{#snippet archiveLink()}
	<a
		class="method-link inline-flex min-h-11 items-center justify-self-start"
		href={localizeHref('/metrics/archive', locale, city)}>{copy.archive}</a
	>
{/snippet}

{#snippet fieldList(
	parts: readonly FieldPart[],
	byId: Map<string, MethodEntry>,
	minimumSample: number | null,
	rankingMinimumSample: number | null,
	since: string | null,
)}
	{#if parts.length || minimumSample != null || rankingMinimumSample != null || since}
		<dl class="method-parts">
			{#each parts as part (part.field)}
				<div>
					<dt>{copy[part.field]}</dt>
					{#if part.lead}<dd>{part.lead}</dd>{/if}
					{#if part.shared.length}
						<dd>
							{copy.sameAs}
							{#each part.shared as owner, index (owner)}{#if index > 0},
								{/if}<a class="method-link" href={'#' + owner}
									>{sameAsName(byId.get(owner)!, locale)}</a
								>{/each}.
						</dd>
					{/if}
				</div>
			{/each}
			{#if minimumSample != null}
				<div>
					<dt>{copy.minimum}</dt>
					<dd>{tally(minimumSample, locale)}</dd>
				</div>
			{/if}
			{#if rankingMinimumSample != null}
				<div>
					<dt>{copy.rankingMinimum}</dt>
					<dd>{tally(rankingMinimumSample, locale)}</dd>
				</div>
			{/if}
			{#if since}
				<div>
					<dt>{copy.since}</dt>
					<dd><time datetime={since}>{longDate(since, locale)}</time></dd>
				</div>
			{/if}
		</dl>
	{/if}
{/snippet}

{#snippet dataUsersDisclosure(id: string, notes: readonly DataUserNote[])}
	{#if notes.length}
		<div class="mt-4">
			{#snippet notesBody()}
				<dl class="method-notes">
					{#each notes as note, index (index)}
						<div>
							{#if note.label || note.field}
								<dt>
									{#if note.label && note.field}{note.label} · {copy[
											note.field
										]}{:else if note.label}{note.label}{:else if note.field}{copy[note.field]}{/if}
								</dt>
							{/if}
							<dd>{note.text}</dd>
						</div>
					{/each}
				</dl>
			{/snippet}
			{@render methodSection(id + '-notes', copy.dataUsers, notesBody, undefined, true, 4)}
		</div>
	{/if}
{/snippet}

{#snippet groupCard(view: GroupView, byId: Map<string, MethodEntry>)}
	{#if view.measures.length === 1}
		{@const item = view.measures[0]}
		{#snippet measureDetails()}
			{@render fieldList(
				item.parts,
				byId,
				item.minimumSample,
				item.rankingMinimumSample,
				item.since,
			)}
			{@render dataUsersDisclosure(item.entry.id, view.dataUsers)}
		{/snippet}
		{@render methodSection(
			item.entry.id,
			methodName(item.entry, locale),
			measureDetails,
			item.summary,
		)}
	{:else}
		{#snippet groupDetails()}
			<div class="grid min-w-0 gap-5">
				<div class="grid min-w-0 gap-4">
					{#each view.measures as item (item.entry.id)}
						<section class="grid min-w-0 gap-2">
							<h4
								id={item.entry.id}
								aria-labelledby={item.entry.id + '-title'}
								class="method-anchor"
							>
								<HeadingPermalink target={item.entry.id} label={permalinkLabel} />
								<span id={item.entry.id + '-title'}>{methodName(item.entry, locale)}</span>
							</h4>
							<p>{item.summary}</p>
							{@render fieldList(
								item.parts,
								byId,
								item.minimumSample,
								item.rankingMinimumSample,
								item.since,
							)}
						</section>
					{/each}
				</div>
				{#if view.sharedParts.length || view.sharedMinimumSample != null || view.sharedRankingMinimumSample != null || view.sharedSince}
					<div class="grid min-w-0 gap-2 pt-1">
						<p class="shared-heading">{copy.sharedAcross}</p>
						{@render fieldList(
							view.sharedParts,
							byId,
							view.sharedMinimumSample,
							view.sharedRankingMinimumSample,
							view.sharedSince,
						)}
					</div>
				{/if}
			</div>
			{@render dataUsersDisclosure(view.group.id, view.dataUsers)}
		{/snippet}
		{@render methodSection(view.group.id, view.group.name, groupDetails, view.group.summary)}
	{/if}
{/snippet}

{#snippet rankingRange()}
	<dl class="method-parts">
		{#each rangeFields as field (field)}
			<div>
				<dt>{copy[field]}</dt>
				<dd>{copy.range[field]}</dd>
			</div>
		{/each}
	</dl>
	<div class="mt-4">
		{#snippet rankingNotes()}
			<dl class="method-notes">
				{#each dataUserFields as field (field)}
					<div>
						<dt>{copy[field]}</dt>
						<dd>{copy.range.dataUsers[field]}</dd>
					</div>
				{/each}
			</dl>
		{/snippet}
		{@render methodSection('ranking-range-notes', copy.dataUsers, rankingNotes, undefined, true)}
	</div>
{/snippet}

{#snippet aboutTransit()}
	<!-- An email address is one long word: let it wrap at 200% text on a phone. -->
	<dl class="method-parts [overflow-wrap:anywhere]">
		{#each copy.about.fields as field (field.label)}
			<div>
				<dt>{field.label}</dt>
				<dd>{field.text}</dd>
				{#if 'link' in field}
					<dd>
						<a class="method-link inline-flex min-h-11 items-center" href={field.link.href}
							>{field.link.label}</a
						>
					</dd>
				{/if}
			</div>
		{/each}
	</dl>
{/snippet}

{#snippet actions(entries: MethodEntry[])}
	{#snippet pageCite()}
		<CiteBlock {locale} text={pageCitation(title, null, canonical.href, locale)} />
	{/snippet}
	{#snippet citations()}
		{#each entries as entry (entry.id)}
			{@const share = recordSectionLinks(canonical, entry.id).share}
			<CiteBlock
				{locale}
				text={`Transit. ${title}. ${registryUnitText(entry.text[locale].definition, locale)} (${versionNumber(
					entry.method_version,
				)}, ${longDate(entry.since, locale)}). ${share}`}
			/>
		{/each}
	{/snippet}
	<RecordActionGroup
		{locale}
		href={canonical.href}
		citation={pageCite}
		figures={citations}
		print={() => window.print()}
		files={entries
			.filter((entry) => entry.csv_columns[locale].length)
			.map((entry) => ({
				href: period ? recordSectionLinks(csvScope, entry.id).csv : undefined,
				label: methodName(entry, locale),
				columns: entry.csv_columns[locale].map((column) => registryUnitText(column, locale)),
			}))}
	/>
{/snippet}

<RecordScreen>
	<DetailFrame
		class="method-detail reading-detail"
		measure="var(--transit-measure-listing)"
		rule="none"
		railScroll
		bind:activeId
		toc={{
			entries,
			navigation,
			onNavigate: (id) => void navigation.jump(id, { beforeReveal: revealMethod }),
			openAria: contentsLabel,
			closeAria: choose(locale, 'Close', 'Fermer'),
			counter: false,
			landFragments: true,
		}}
	>
		{#snippet summary()}
			<ArticleHeader
				{title}
				subtitle={copy.intro}
				presentation="reading"
				backHref={localizeHref('/', locale, city)}
				backLabel={choose(locale, 'Overview', 'Aperçu')}
			/>
		{/snippet}

		{#snippet left()}
			<div class="grid gap-(--space-card-gap) print:hidden">
				<nav aria-label={contentsLabel}>
					<p class="method-contents-title">{contentsLabel}</p>
					<ul class="mt-2 grid gap-1">
						{#each railEntries as entry (entry.id)}
							<li aria-hidden={entry.id === 'more-methods' && !hasMore ? true : undefined}>
								{#if entry.id === 'more-methods' && !hasMore}
									<!-- Keep the row at its text-scaled height while the catalogue streams. -->
									<span class="invisible inline-flex min-h-11 items-center">{entry.title}</span>
								{:else}
									<a
										class="method-link inline-flex min-h-11 items-center aria-[current=location]:font-bold"
										href={'#' + entry.id}
										aria-current={activeId === entry.id ? 'location' : undefined}>{entry.title}</a
									>
								{/if}
							</li>
						{/each}
					</ul>
				</nav>
				{@render archiveLink()}
			</div>
		{/snippet}

		<!-- Reserve the opposite track so the reading column stays centred. -->
		{#snippet right()}{/snippet}

		<div
			class="method-content article-body reading-column"
			bind:this={reading}
			data-method-ready={ready ? '' : undefined}
		>
			{#await catalogue}
				<RecordGroup aria-labelledby="method-heading"
					>{@render measuresHeading()}
					{#key catalog}<RecordPending
							shape={{ shape: 'tiles', count: 16 }}
							{locale}
							answer={catalog}
						/>{/key}</RecordGroup
				>
			{:then { result, groups, extra }}
				{#if result.kind !== 'answer'}
					<RecordGroup>
						{@render measuresHeading()}
						<div data-slot="screen-state">
							{#if result.kind === 'busy'}<RecordPending {locale} busy />
							{:else}<RecordAnswer
									value={null}
									sentence={recordConnection[result.kind][locale]}
									{locale}
								/>{/if}
						</div>
					</RecordGroup>
				{:else}
					{@const allViews = buildMethodViews([...groups, ...extra], locale)}
					{@const primaryViews = allViews.slice(0, groups.length)}
					{@const extraViews = allViews.slice(groups.length)}
					{@const ids = [
						...allViews.map(({ measures, group }) =>
							measures.length === 1 ? measures[0].entry.id : group.id,
						),
						...referenceSections,
					]}
					{@const ordered = [...groups, ...extra].flatMap(({ entries }) => entries)}
					{@const byId = new Map(ordered.map((entry) => [entry.id, entry]))}
					<RecordGroup>
						{#if result.answer.length}{@render actions(result.answer)}{/if}
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
								>.
							</p>
						{/if}
					</RecordGroup>
					<RecordGroup aria-labelledby="method-heading">
						{@render measuresHeading(ids)}
						<div class="contents" bind:this={methodList}>
							{#each primaryViews as view (view.group.id)}{@render groupCard(view, byId)}{/each}
						</div>
					</RecordGroup>
					{#if extraViews.length}
						<RecordGroup aria-labelledby="more-methods">
							<h2
								id="more-methods"
								aria-labelledby="more-methods-title"
								class="section-title"
								bind:this={extraHeading}
							>
								<HeadingPermalink target="more-methods" label={permalinkLabel} />
								<span id="more-methods-title">{copy.more}</span>
							</h2>
							{#each extraViews as view (view.group.id)}{@render groupCard(view, byId)}{/each}
						</RecordGroup>
					{/if}
				{/if}
			{/await}
			<RecordGroup>
				{@render methodSection(
					'ranking-range',
					copy.range.title,
					rankingRange,
					undefined,
					false,
					2,
				)}
			</RecordGroup>
			<RecordGroup>
				<article class="grid gap-4" aria-labelledby="reading-states-title">
					<h2
						id="reading-states"
						aria-labelledby="reading-states-title"
						class="method-anchor section-title"
					>
						<HeadingPermalink target="reading-states" label={permalinkLabel} />
						<span id="reading-states-title">{copy.statesTitle}</span>
					</h2>
					<dl class="method-parts">
						{#each methodReferenceStates as state (state)}
							<div>
								<dt><StateMark {state} {locale} /></dt>
								<dd>{copy.states[state]}</dd>
							</div>
						{/each}
					</dl>
					<p>{copy.unknown}</p>
					<p class="mt-4 text-muted-foreground">{copy.statesNote}</p>
				</article>
			</RecordGroup>
			<RecordGroup>
				<article class="grid gap-4" aria-labelledby="record-limits-title">
					<h2
						id="record-limits-heading"
						aria-labelledby="record-limits-title"
						class="section-title"
					>
						<HeadingPermalink target="record-limits-heading" label={permalinkLabel} />
						<span id="record-limits-title">{copy.limitsTitle}</span>
					</h2>
					<div class="@container">
						<ul class="method-limits list-outside list-disc ps-5 @max-[10rem]:ps-3">
							{#each copy.recordLimits as line (line)}<li>{line}</li>{/each}
						</ul>
					</div>
				</article>
			</RecordGroup>
			<RecordGroup>
				{@render methodSection(
					'about-transit',
					copy.about.title,
					aboutTransit,
					copy.about.summary,
					false,
					2,
				)}
				<div class="lg:hidden print:block">{@render archiveLink()}</div>
			</RecordGroup>
		</div>
	</DetailFrame>
</RecordScreen>

<style>
	.method-content {
		container-type: inline-size;
	}
	.method-parts,
	.method-notes,
	.method-limits {
		display: grid;
		gap: var(--space-card-gap);
	}
	.method-anchor {
		scroll-margin-block-start: var(--space-page-x);
	}
	dt {
		font-weight: 600;
		color: var(--muted-foreground);
	}
	.shared-heading {
		margin: 0;
		font-size: var(--text-small);
		font-weight: 600;
		color: var(--muted-foreground);
	}
	.method-contents-title {
		font-size: var(--text-heading);
		font-weight: 700;
	}
	/* The kit's pre-paint choice also applies to the editorial disclosures before hydration. */
	:global(html[data-sections-saved][data-sections-choice='expanded'])
		.method-content:not([data-method-ready])
		:global([data-method-bulk] > [data-slot='collapsible-content']) {
		grid-template-rows: 1fr;
		opacity: 1;
		transition: none;
	}
	:global(html[data-sections-saved][data-sections-choice='collapsed'])
		.method-content:not([data-method-ready])
		:global([data-method-bulk] > [data-slot='collapsible-content']) {
		grid-template-rows: 0fr;
		opacity: 0;
		transition: none;
	}
	.method-link {
		color: var(--primary);
		text-decoration: underline;
	}
	:global(.method-detail [data-slot='detail-shell-right']:empty) {
		display: none;
	}
	:global(.method-detail) {
		--method-return-row: max(44px, calc(1.5 * var(--text-back-link)));
	}
	:global(.method-detail .detail-shell-grid) {
		padding-block-start: 0;
	}
	:global(.method-detail [data-slot='detail-shell-summary']) {
		--chrome-offset: 0px;
		margin-block-end: var(--space-card-gap);
	}
	:global(.method-detail [data-slot='article-header'] .header__content) {
		max-inline-size: none;
		padding-inline: 0;
	}
	:global(.method-detail [data-slot='article-header'] .header__back) {
		min-block-size: var(--method-return-row);
		line-height: 1.5;
		margin-block-end: 0;
	}
	@media screen and (min-width: 64rem) {
		:global(.method-detail [data-slot='detail-shell-left']) {
			margin-block-start: var(--method-return-row);
		}
	}
	@media screen and (min-width: 80rem) {
		:global(.method-detail.detail-shell[data-slot='detail-shell']) {
			--detail-grid-gap: min(2rem, 2.5vw);
		}
	}
	@media print {
		:global(.method-detail .detail-shell-grid) {
			display: block;
			padding: 0;
		}
	}
	@container (min-width: 36rem) {
		.method-parts,
		.method-limits {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
	}
</style>
