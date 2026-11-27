<script lang="ts">
	import { untrack } from 'svelte';
	import { Button } from '@yesid/ui/button';
	import RecordScreen from './RecordScreen.svelte';
	import RecordGroup from './RecordGroup.svelte';
	import { Surface } from '@yesid/ui/layout';
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
	import ScreenTitle from './ScreenTitle.svelte';
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
		catalog: Promise<EngineResult<MethodEntry[]>>;
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
	let measures = $state<HTMLElement>();
	let methodList = $state<HTMLElement>();
	let openCards = $state<Record<string, boolean>>({ on_time: true });
	const hasOpenCards = $derived.by(() => {
		if (!methodList || !measures) return false;
		return Array.from(
			measures.querySelectorAll<HTMLElement>(
				'[data-record-disclosure]:not([data-record-disclosure] *)',
			),
		).some(({ id }) => openCards[id]);
	});

	$effect(() => {
		const node = methodList ?? measures;
		const hash = url.hash.slice(1);
		if (!hash || !node) return;
		const target = document.getElementById(hash);
		if (!target || !measures?.contains(target) || !node) return;
		untrack(() => {
			let card = target.closest<HTMLElement>('[data-record-disclosure]');
			while (card) {
				openCards[card.id] = true;
				card = card.parentElement?.closest<HTMLElement>('[data-record-disclosure]') ?? null;
			}
		});
		const frame = requestAnimationFrame(() => target.scrollIntoView({ block: 'start' }));
		return () => cancelAnimationFrame(frame);
	});

	function toggleAll() {
		if (!measures) return;
		openCards = hasOpenCards
			? {}
			: Object.fromEntries(
					Array.from(
						measures.querySelectorAll<HTMLElement>('[data-record-disclosure]:not([id$="-notes"])'),
						({ id }) => [id, true],
					),
				);
	}
</script>

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
			<RecordCard
				title={copy.dataUsers}
				bind:open={openCards[id + '-notes']}
				disclosure={{ id: id + '-notes', nested: true }}
			>
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
			</RecordCard>
		</div>
	{/if}
{/snippet}

{#snippet groupCard(view: GroupView, byId: Map<string, MethodEntry>)}
	{#if view.measures.length === 1}
		{@const item = view.measures[0]}
		<RecordCard
			title={methodName(item.entry, locale)}
			bind:open={openCards[item.entry.id]}
			disclosure={{
				id: item.entry.id,
				description: item.summary,
				chevronBesideTitle: true,
			}}
		>
			{@render fieldList(
				item.parts,
				byId,
				item.minimumSample,
				item.rankingMinimumSample,
				item.since,
			)}
			{@render dataUsersDisclosure(item.entry.id, view.dataUsers)}
		</RecordCard>
	{:else}
		<RecordCard
			bind:open={openCards[view.group.id]}
			title={view.group.name}
			disclosure={{
				id: view.group.id,
				description: view.group.summary,
				chevronBesideTitle: true,
			}}
		>
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
		</RecordCard>
	{/if}
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
	<RecordScreen class="reading-column">
		<div data-slot="screen-content" class="method-content min-w-0">
			<RecordGroup
				><ScreenTitle {title} />
				<p data-slot="screen-answer">{copy.intro}</p>
				<nav aria-label={choose(locale, 'On this page', 'Sur cette page')}>
					<ul class="flex flex-wrap gap-x-4">
						{#each [['method-heading', copy.heading], ['reading-states', copy.statesTitle], ['about-transit', copy.about.title]] as [id, label] (id)}<li
							>
								<a class="method-link inline-flex min-h-11 items-center" href={'#' + id}>{label}</a>
							</li>{/each}
					</ul>
				</nav></RecordGroup
			>
			<div class="min-w-0" bind:this={measures}>
				{#await catalog}
					<RecordGroup aria-labelledby="method-heading"
						><h2 id="method-heading">{copy.heading}</h2>
						{#key catalog}<RecordPending
								shape={{ shape: 'tiles', count: 16 }}
								{locale}
								answer={catalog}
							/>{/key}</RecordGroup
					>
				{:then result}
					{#if result.kind !== 'answer'}
						<RecordGroup>
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
							<header class="flex flex-wrap items-center justify-between gap-3">
								<h2 id="method-heading">{copy.heading}</h2>
								{#if ordered.length}
									<Button variant="outline" size="cta-sm" wrap class="min-h-11" onclick={toggleAll}
										>{hasOpenCards
											? sectionsToggleCopy[locale].collapse
											: sectionsToggleCopy[locale].expand}</Button
									>
								{/if}
							</header>
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
					<RecordCard
						title={copy.range.title}
						bind:open={openCards['ranking-range']}
						disclosure={{ id: 'ranking-range', description: copy.range.summary }}
					>
						<dl class="method-parts">
							{#each rangeFields as field (field)}
								<div>
									<dt>{copy[field]}</dt>
									<dd>{copy.range[field]}</dd>
								</div>
							{/each}
						</dl>
						<div class="mt-4">
							<RecordCard
								title={copy.dataUsers}
								bind:open={openCards['ranking-range-notes']}
								disclosure={{ id: 'ranking-range-notes', nested: true }}
							>
								<dl class="method-notes">
									{#each dataUserFields as field (field)}
										<div>
											<dt>{copy[field]}</dt>
											<dd>{copy.range.dataUsers[field]}</dd>
										</div>
									{/each}
								</dl>
							</RecordCard>
						</div>
					</RecordCard>
					<div id="reading-states">
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
					<RecordCard
						title={copy.about.title}
						bind:open={openCards['about-transit']}
						disclosure={{ id: 'about-transit', description: copy.about.summary }}
					>
						<!-- An email address is one long word: let it wrap at 200% text on a phone. -->
						<dl class="method-parts [overflow-wrap:anywhere]">
							{#each copy.about.fields as field (field.label)}
								<div>
									<dt>{field.label}</dt>
									<dd>{field.text}</dd>
									{#if 'link' in field}
										<dd>
											<a
												class="method-link inline-flex min-h-11 items-center"
												href={field.link.href}>{field.link.label}</a
											>
										</dd>
									{/if}
								</div>
							{/each}
						</dl>
					</RecordCard>
				</RecordGroup>
			</div>
			<RecordGroup>
				<a
					class="method-link inline-flex min-h-11 items-center justify-self-start"
					href={localizeHref('/metrics/archive', locale, city)}>{copy.archive}</a
				>
			</RecordGroup>
		</div>
	</RecordScreen>
</Surface>

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
	.measure-item {
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
	@container (min-width: 36rem) {
		.method-parts,
		.method-limits {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
	}
</style>
