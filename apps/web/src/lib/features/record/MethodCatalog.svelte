<script lang="ts">
	import type { Awaitable } from '#lib/site/ready.ts';
	import type { Snippet } from 'svelte';
	import { afterNavigate } from '$app/navigation';
	import {
		CollapsibleSection,
		SectionsToggle,
		TocNav,
		useSectionJump,
		type TocEntry,
	} from '@yesid/ui/brand';
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
	import RecordCard from './RecordCard.svelte';
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
	$effect(() => {
		if (methodList && url.hash) void navigation.jump(url.hash.slice(1), { behavior: 'auto' });
	});
	const contentsLabel = $derived(choose(locale, 'On this page', 'Sur cette page'));
	const entries: TocEntry[] = $derived([
		{ id: 'method-heading', title: copy.heading, level: 2, children: [] },
		{ id: 'reading-states', title: copy.statesTitle, level: 2, children: [] },
		{ id: 'about-transit', title: copy.about.title, level: 2, children: [] },
	]);
</script>

{#snippet methodSection(
	id: string,
	name: string,
	details: Snippet,
	description?: string,
	independent = false,
)}
	{#snippet summary()}
		<p>{description}</p>
	{/snippet}
	<div {id} class="method-anchor">
		<CollapsibleSection
			title={name}
			anchor={id}
			open={id === 'on_time'}
			firstVisitClosed={id !== 'on_time'}
			{independent}
			headerVariant="article-summary"
			textSize="inherit"
			edge="neutral"
			edgeWeight="thin"
			summary={description ? summary : undefined}
		>
			{@render details()}
		</CollapsibleSection>
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
			{@render methodSection(id + '-notes', copy.dataUsers, notesBody, undefined, true)}
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
						<section id={item.entry.id} class="measure-item grid min-w-0 gap-2">
							<h3>{methodName(item.entry, locale)}</h3>
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
		class="method-detail"
		measure="var(--transit-measure-listing)"
		rule="none"
		railScroll
		bind:activeId
		toc={{
			entries,
			navigation,
			openAria: contentsLabel,
			closeAria: choose(locale, 'Close', 'Fermer'),
			counter: false,
			landFragments: true,
		}}
	>
		{#snippet header()}
			<ArticleHeader
				{title}
				subtitle={copy.intro}
				presentation="reading"
				backHref={localizeHref('/', locale, city)}
				backLabel={choose(locale, 'Overview', 'Aperçu')}
			>
				{#snippet controls()}
					<div class="min-h-11 print:hidden">
						<SectionsToggle copy={sectionsToggleCopy[locale]} activeEffect="none" />
					</div>
				{/snippet}
			</ArticleHeader>
		{/snippet}

		{#snippet left()}
			<div class="print:hidden">
				<TocNav {entries} {activeId} {navigation} heading={contentsLabel} counter={false} />
			</div>
		{/snippet}

		{#snippet right()}
			<div class="print:hidden">{@render archiveLink()}</div>
		{/snippet}

		<div class="method-content reading-column min-w-0">
			{#await catalog}
				<RecordGroup aria-labelledby="method-heading"
					><h2 id="method-heading" tabindex="-1">{copy.heading}</h2>
					{#key catalog}<RecordPending
							shape={{ shape: 'tiles', count: 16 }}
							{locale}
							answer={catalog}
						/>{/key}</RecordGroup
				>
			{:then result}
				{#if result.kind !== 'answer'}
					<RecordGroup>
						<h2 id="method-heading" tabindex="-1">{copy.heading}</h2>
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
					{@const { groups, extra } = methodGroups(result.answer, locale)}
					{@const allViews = buildMethodViews([...groups, ...extra], locale)}
					{@const primaryViews = allViews.slice(0, groups.length)}
					{@const extraViews = allViews.slice(groups.length)}
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
						<h2 id="method-heading" tabindex="-1">{copy.heading}</h2>
						<div class="contents" bind:this={methodList}>
							{#each primaryViews as view (view.group.id)}{@render groupCard(view, byId)}{/each}
						</div>
					</RecordGroup>
					{#if extraViews.length}
						<RecordGroup aria-labelledby="more-methods">
							<h2 id="more-methods">{copy.more}</h2>
							{#each extraViews as view (view.group.id)}{@render groupCard(view, byId)}{/each}
						</RecordGroup>
					{/if}
				{/if}
			{/await}
			<RecordGroup>
				{@render methodSection('ranking-range', copy.range.title, rankingRange, copy.range.summary)}
				<div id="reading-states" class="method-anchor">
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
				</div>
				<RecordCard title={copy.limitsTitle}>
					<div class="@container">
						<ul class="method-limits list-outside list-disc ps-5 @max-[10rem]:ps-3">
							{#each copy.recordLimits as line (line)}<li>{line}</li>{/each}
						</ul>
					</div>
				</RecordCard>
				{@render methodSection('about-transit', copy.about.title, aboutTransit, copy.about.summary)}
				<div class="lg:hidden print:block">{@render archiveLink()}</div>
			</RecordGroup>
		</div>
	</DetailFrame>
</RecordScreen>

<style>
	.method-content {
		container-type: inline-size;
		overflow-wrap: normal;
		word-break: normal;
	}
	.method-parts,
	.method-notes,
	.method-limits {
		display: grid;
		gap: var(--space-card-gap);
	}
	.measure-item,
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
	h2 {
		font-size: var(--text-heading);
		font-weight: 700;
	}
	h3 {
		margin: 0;
		font-size: inherit;
		font-weight: 600;
	}
	.method-link {
		color: var(--primary);
		text-decoration: underline;
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
		:global(.method-detail .section-header__chevron) {
			display: none;
		}
	}
	@container (min-width: 36rem) {
		.method-parts,
		.method-limits {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
	}
</style>
