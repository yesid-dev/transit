<script lang="ts">
	import type { Locale } from '#lib/i18n/index.ts';
	import { DashboardGrid } from '@yesid/ui/layout';
	import { ExplainedMetricCard } from '#lib/components/dataviz/index.ts';
	import { TerminalPanel, type TerminalFooterItem } from '@yesid/ui/brand';
	import MetricInfo from '#lib/features/metrics/MetricInfo.svelte';
	import NetworkTile from './NetworkTile.svelte';
	import type { KpiCardVM } from '../selectors/headlineKpis';
	import type { NetworkReliabilityCopy } from '../network-reliability.copy';

	interface SectionLiveHeadlineProps {
		cards: readonly KpiCardVM[];
		locale: Locale;
		copy: NetworkReliabilityCopy;
		terminal: {
			title: string;
			tag: string;
			footerItems: TerminalFooterItem[];
		};
	}
	let { cards, locale, copy, terminal }: SectionLiveHeadlineProps = $props();
</script>

<NetworkTile
	subtitle={copy.questions.live}
	title={copy.liveSection}
	sectionKey="network-live-headline"
>
	<p class="network-live-lede" data-slot="network-lede">{copy.lede}</p>
	<TerminalPanel title={terminal.title} tag={terminal.tag} footer={terminal.footerItems}>
		<DashboardGrid minTile="max(220px, calc((100% - var(--space-card-gap)) / 2))" gutter={false}>
			{#each cards as card (card.label)}
				<ExplainedMetricCard
					label={card.label}
					value={card.value}
					absentReason={card.absentReason}
					absentParams={card.absentParams}
					{locale}
					size="lg"
				>
					{#snippet info()}
						<MetricInfo metricKey={card.key} {locale} name={card.label} side="bottom" />
					{/snippet}
				</ExplainedMetricCard>
			{/each}
		</DashboardGrid>
	</TerminalPanel>
</NetworkTile>

<style>
	/*
	 * Each card keeps its large figure's line when it shows an absence instead (a share held back for
	 * too few readings, or one not reported), so a refresh never moves the cards below. The line
	 * follows the sizes the release gives .metric-value.text-title: heading on phones, title wider.
	 */
	:global([data-network-section='network-live-headline'] [data-slot='metric-display']) {
		--live-figure-line: calc(var(--text-heading) * 1.5);
	}
	@media (--tablet-min) {
		:global([data-network-section='network-live-headline'] [data-slot='metric-display']) {
			--live-figure-line: calc(var(--text-title) * 1.5);
		}
	}
	:global(
		[data-network-section='network-live-headline']
			[data-slot='metric-display']
			> :is(.metric-value, [data-slot='absent-value'])
	) {
		min-block-size: var(--live-figure-line);
	}
	.network-live-lede {
		margin: 0 0 var(--space-card-gap);
		color: var(--muted-foreground);
		font-size: var(--text-reading-support);
		line-height: 1.7;
	}
</style>
