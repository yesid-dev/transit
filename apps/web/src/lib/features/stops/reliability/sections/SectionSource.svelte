<script lang="ts">
	import type { Locale } from '#lib/i18n/index.ts';
	import type { StopReliability } from '#lib/v1/index.ts';
	import { formatDateKey } from '#lib/utils/time.ts';
	import type { StopReliabilityCopy } from '../stops-reliability.copy';

	interface SectionSourceProps {
		data: Pick<StopReliability, 'generated_utc' | 'methodology_version' | 'publish_generation_id'>;
		locale: Locale;
		copy: StopReliabilityCopy;
		/** How we measure, at the stop measure. */
		href: string;
	}
	let { data, locale, copy, href }: SectionSourceProps = $props();

	const t = $derived(copy.source);
	const built = $derived(
		typeof data.generated_utc === 'string' && /^\d{4}-\d{2}-\d{2}/u.test(data.generated_utc)
			? formatDateKey(data.generated_utc.slice(0, 10), locale, true)
			: null,
	);
	const text = (value: string | null | undefined) =>
		typeof value === 'string' && value.trim() !== '' ? value : null;
	const facts = $derived([
		{ label: t.built, value: built },
		{ label: t.method, value: text(data.methodology_version) },
		{ label: t.generation, value: text(data.publish_generation_id) },
	]);
</script>

<div class="stop-source" data-slot="stop-source">
	<p>{t.reading}</p>
	<dl class="stop-source__facts">
		{#each facts as fact (fact.label)}
			<div>
				<dt>{fact.label}</dt>
				<dd>
					{#if fact.value != null}<span translate="no">{fact.value}</span
						>{:else}{t.notSupplied}{/if}
				</dd>
			</div>
		{/each}
	</dl>
	<a class="stop-source__link" {href}>{t.howWeMeasure}</a>
</div>

<style>
	.stop-source {
		display: grid;
		gap: 0.75rem;
		max-width: var(--measure-body);
		font-size: var(--text-small);
		line-height: 1.5;
	}
	.stop-source p {
		margin: 0;
	}
	.stop-source__facts {
		display: grid;
		gap: 0.5rem;
		margin: 0;
	}
	.stop-source__facts dt {
		color: var(--muted-foreground);
	}
	.stop-source__facts dd {
		margin: 0;
		overflow-wrap: anywhere;
	}
	.stop-source__link {
		display: inline-flex;
		align-items: center;
		justify-self: start;
		min-block-size: var(--size-tap-min);
		color: var(--primary);
		text-decoration-line: underline;
		text-underline-offset: 0.2em;
	}
	.stop-source__link:focus-visible {
		outline: 2px solid var(--ring);
		outline-offset: 2px;
	}
</style>
