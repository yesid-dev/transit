<script lang="ts">
	import { useAvailableSectionJump } from '#lib/site/availableSectionJump.svelte.ts';
	import { getLocale, getLocalizeHref, type Locale } from '#lib/i18n/index.ts';
	import { ArticleSectionStack } from '#lib/components/layout/index.ts';
	import { DetailFrame, ReadingFrame } from '@yesid/ui/layout';
	import { CollapsibleSection, type TocEntry } from '@yesid/ui/brand';
	import SectionsToggle from '#lib/components/shared/SectionsToggle.svelte';
	import { METRICS, METRIC_CLUSTER_ORDER } from './metrics.content';
	import { metricsCopy } from './metrics.copy';
	import MetricBody, { type MetricSqlHtml } from './MetricBody.svelte';
	import { historyDepthCopy } from './historyDepth.copy';

	const localizeHref = getLocalizeHref();

	let { sqlHtml }: { sqlHtml?: MetricSqlHtml } = $props();

	const locale: Locale = getLocale();
	const t = $derived(metricsCopy[locale]);

	const LACUNES_ANCHOR = 'structural-gaps';

	const LIVE_POSITIONS_ANCHOR = 'live-positions';

	const groups = $derived(
		METRIC_CLUSTER_ORDER.map((cluster) => ({
			cluster,
			label: t.clusters[cluster],
			entries: METRICS.filter((m) => m.cluster === cluster),
		})).filter((g) => g.entries.length > 0),
	);

	const orderedMetrics = $derived(groups.flatMap((g) => g.entries));

	const PROVENANCE_ANCHOR = 'metrics-provenance';
	const HISTORY_ANCHOR = 'history-depth';
	const CONFIDENCE_INTERVALS_ANCHOR = 'confidence-intervals';

	const tocEntries = $derived.by((): TocEntry[] => [
		{
			id: PROVENANCE_ANCHOR,
			title: t.provenance.label,
			level: 2,
			children: [],
		},
		{ id: HISTORY_ANCHOR, title: historyDepthCopy[locale].title, level: 2, children: [] },
		...orderedMetrics.map((entry) => ({
			id: entry.anchor,
			title: entry.name[locale],
			level: 2,
			children: [],
		})),
		{
			id: LIVE_POSITIONS_ANCHOR,
			title: t.livePositions.title,
			level: 2,
			children: [],
		},
		{
			id: LACUNES_ANCHOR,
			title: t.lacunes.title,
			level: 2,
			children: [],
		},
	]);

	const { navigate } = useAvailableSectionJump(
		() => tocEntries,
		(id) => id === CONFIDENCE_INTERVALS_ANCHOR,
	);
</script>

<DetailFrame class="metrics-detail" style="--detail-center-max: 100%">
	{#snippet header()}
		<ReadingFrame
			title={t.heading}
			titleId="metrics-title"
			style="--reading-measure: var(--transit-measure-listing); padding-block: 0"
		>
			{#snippet summary()}
				<a
					class="inline-flex min-h-11 items-center text-primary underline"
					href={localizeHref('/metrics', locale)}
					>{locale === 'fr' ? '← Comment on mesure' : '← How we measure'}</a
				>
				<p>
					{locale === 'fr'
						? 'Ces définitions s’appliquaient au premier site Transit, jusqu’en novembre 2026. Les chiffres de ce site suivent la méthode actuelle.'
						: 'These definitions applied to the first Transit site through November 2026. The figures on this site follow the current method.'}
				</p>
			{/snippet}
			<SectionsToggle />
		</ReadingFrame>
	{/snippet}

	<ArticleSectionStack
		class="reading-column"
		style="margin-inline: auto"
		data-testid="metrics-sections"
	>
		<nav aria-label={t.tocLabel} data-testid="archive-contents">
			<details open>
				<summary class="min-h-11 content-center">{t.tocLabel}</summary>
				<ul class="grid gap-1">
					{#each tocEntries as entry (entry.id)}<li>
							<a
								class="inline-flex min-h-11 items-center text-primary underline"
								href={'#' + entry.id}
								onclick={(event) => {
									event.preventDefault();
									void navigate(entry.id);
								}}>{entry.title}</a
							>
						</li>{/each}
				</ul>
			</details>
		</nav>
		<div class="section-block" id={PROVENANCE_ANCHOR}>
			<CollapsibleSection
				title={t.provenance.label}
				headerVariant="article-summary"
				subtitle={t.questions.provenance}
				anchor={PROVENANCE_ANCHOR}
				open={true}
			>
				<div class="metrics-article-prose">
					<p class="metrics-lede">{t.lede}</p>
					<p class="metrics-preamble">{t.provenance.body}</p>

					<div class="metrics-measure">
						<h3 class="metrics-measure__heading">{t.provenance.howWeMeasure.label}</h3>
						<div class="metrics-measure__item">
							<h3 class="metrics-measure__heading">
								{t.provenance.howWeMeasure.serviceDay.heading}
							</h3>
							<p class="metric__prose">{t.provenance.howWeMeasure.serviceDay.body}</p>
						</div>
						<div class="metrics-measure__item" id={CONFIDENCE_INTERVALS_ANCHOR}>
							<h3 class="metrics-measure__heading">
								{t.provenance.howWeMeasure.confidenceInterval.heading}
							</h3>
							<p class="metric__prose">{t.provenance.howWeMeasure.confidenceInterval.body}</p>
							<a
								class="metric__top"
								href="https://www.itl.nist.gov/div898/handbook/prc/section2/prc241.htm"
								>{t.provenance.howWeMeasure.confidenceInterval.reference}</a
							>
						</div>
						<div class="metrics-measure__item">
							<h3 class="metrics-measure__heading">
								{t.provenance.howWeMeasure.rounding.heading}
							</h3>
							<p class="metric__prose">{t.provenance.howWeMeasure.rounding.body}</p>
						</div>
					</div>

					<div class="metrics-legend">
						<h3 class="metrics-measure__heading">{t.confidence.label}</h3>
						<ul class="metrics-legend__list">
							{#each Object.entries(t.confidence.levels) as [level, info] (level)}
								<li class="metrics-legend__item">
									<strong>{info.chip}</strong>
									<span class="metrics-legend__meaning">{info.meaning}</span>
								</li>
							{/each}
						</ul>
					</div>
				</div>
			</CollapsibleSection>
		</div>

		<div class="section-block" id={HISTORY_ANCHOR}>
			<CollapsibleSection
				title={historyDepthCopy[locale].title}
				subtitle={historyDepthCopy[locale].question}
				headerVariant="article-summary"
				anchor={HISTORY_ANCHOR}
				open={true}
			>
				<p>
					{locale === 'fr'
						? 'Consultez la couverture du bilan actuel par date et par source.'
						: 'See what the current record covers by date and source.'}
				</p>
				<a class="metric__top" href={localizeHref('/status', locale)}
					>{historyDepthCopy[locale].details}</a
				>
			</CollapsibleSection>
		</div>

		{#each groups as group (group.cluster)}
			<div class="metrics-cluster">
				<h2 class="text-heading font-semibold">{group.label}</h2>
				<ArticleSectionStack class="metrics-cluster__cards" data-slot-variant="metric-cluster">
					{#each group.entries as entry (entry.key)}
						<div class="section-block" id={entry.anchor}>
							<CollapsibleSection
								title={entry.name[locale]}
								subtitle={entry.oneLiner[locale]}
								headerVariant="article-summary"
								anchor={entry.anchor}
								open={true}
							>
								<div class="metric__body">
									<div class="metric__information-stack">
										<MetricBody {entry} {locale} sqlHtml={sqlHtml?.[entry.key]} />
									</div>
								</div>
							</CollapsibleSection>
						</div>
					{/each}
				</ArticleSectionStack>
			</div>
		{/each}

		<div class="section-block metrics-live" id={LIVE_POSITIONS_ANCHOR}>
			<CollapsibleSection
				title={t.livePositions.title}
				headerVariant="article-summary"
				subtitle={t.questions.positions}
				anchor={LIVE_POSITIONS_ANCHOR}
				open={true}
			>
				<div class="metric__body">
					<p class="metric__prose metrics-live__lede">{t.livePositions.lede}</p>
					<ul class="metrics-live__list">
						{#each t.livePositions.points as point (point.heading)}
							<li class="metrics-live__point">
								<h3 class="metrics-live__heading">{point.heading}</h3>
								<p class="metric__prose">{point.body}</p>
							</li>
						{/each}
					</ul>
				</div>
			</CollapsibleSection>
		</div>

		<div class="section-block metrics-lacunes" id={LACUNES_ANCHOR}>
			<CollapsibleSection
				title={t.lacunes.title}
				headerVariant="article-summary"
				subtitle={t.questions.gaps}
				anchor={LACUNES_ANCHOR}
				open={true}
			>
				<div class="metric__body">
					<p class="metric__prose metrics-lacunes__lede">{t.lacunes.lede}</p>
					<ul class="metrics-lacunes__list">
						{#each t.lacunes.gaps as gap (gap.heading)}
							<li class="metrics-lacunes__gap">
								<h3 class="metrics-lacunes__heading">{gap.heading}</h3>
								<p class="metric__prose">{gap.body}</p>
							</li>
						{/each}
					</ul>
				</div>
			</CollapsibleSection>
		</div>
		<a class="metric__top" href="#metrics-title">{t.backToTop}</a>
	</ArticleSectionStack>
</DetailFrame>

<style>
	.metrics-lede {
		margin: 0;
		color: var(--secondary-foreground);
	}

	.metrics-article-prose {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}
	.metrics-preamble {
		margin: 0;
		color: var(--muted-foreground);
	}
	.metrics-measure {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}
	.metrics-measure__item {
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
	}
	.metrics-measure__heading,
	.metrics-lacunes__heading,
	.metrics-live__heading {
		margin: 0;
		font-family: var(--font-heading);
		font-size: var(--text-reading-heading);
		font-weight: 600;
		line-height: 1.4;
		color: var(--foreground);
	}
	.metrics-legend {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}
	.metrics-legend__list {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.metrics-legend__item {
		display: flex;
		align-items: baseline;
		gap: 0.625rem;
	}
	.metrics-legend__meaning {
		color: var(--muted-foreground);
		font-size: var(--text-reading-support);
		line-height: 1.7;
	}

	.metrics-cluster {
		min-width: 0;
	}
	:global(.metrics-cluster__overline) {
		margin-block-end: var(--space-card-gap);
	}

	.metric__body {
		display: flex;
		flex-direction: column;
		gap: 1.25rem;
	}
	.metric__information-stack {
		display: flex;
		flex-direction: column;
		gap: 1rem;
		min-width: 0;
	}
	.metric__prose {
		margin: 0;
		color: var(--foreground);
	}
	.metric__prose {
		font-size: inherit;
		line-height: inherit;
	}
	.metrics-lacunes__lede,
	.metrics-live__lede {
		color: var(--muted-foreground);
	}
	.metrics-lacunes__list,
	.metrics-live__list {
		display: flex;
		flex-direction: column;
		gap: 1.25rem;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.metrics-lacunes__gap,
	.metrics-live__point {
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
		padding-block-start: 1.25rem;
		border-block-start: 1px solid var(--border-hairline, var(--border));
	}
	.metrics-lacunes__gap:first-child,
	.metrics-live__point:first-child {
		padding-block-start: 0;
		border-block-start: none;
	}
	.metric__top {
		display: inline-flex;
		min-block-size: var(--size-tap-min);
		align-items: center;
		align-self: flex-start;
		font-family: var(--font-mono);
		font-size: var(--text-caption);
		letter-spacing: var(--tracking-eyebrow);
		color: var(--primary);
		text-decoration: none;
		transition: opacity var(--duration-normal) var(--ease-default);
	}
	.metric__top:hover,
	.metric__top:focus-visible {
		text-decoration: underline;
	}
	.metric__top:focus-visible {
		outline: 2px solid var(--ring);
		outline-offset: 2px;
		border-radius: 2px;
	}

	.metrics-article-prose,
	.metrics-live__lede,
	.metrics-live__point p,
	.metrics-lacunes__lede,
	.metrics-lacunes__gap p {
		font-size: var(--text-reading);
		line-height: 1.7;
	}

	@media (--desktop-min) {
		.metrics-article-prose,
		.metrics-live__lede,
		.metrics-live__point p,
		.metrics-lacunes__lede,
		.metrics-lacunes__gap p {
			font-size: var(--text-reading-desktop);
		}
		.metrics-measure__heading,
		.metrics-lacunes__heading,
		.metrics-live__heading {
			font-size: var(--text-reading-heading-desktop);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.metric__top {
			transition: none;
		}
	}
</style>
