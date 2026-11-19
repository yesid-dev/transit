<script lang="ts">
	import type { Locale } from '#lib/i18n/index.ts';
	import { transitDisplay } from '#lib/site/transitDisplayContext.ts';
	import { alertDisplayText, alertLanguageNotice } from '#lib/v1/alertDisplay.ts';
	import type { StopNotice } from './stopIdentity';
	import { detailCopy } from './stops.copy';

	interface Props {
		locale: Locale;
		operator: string;
		/** Notices in effect now, those naming the stop first. */
		current: readonly StopNotice[];
		/** Where "Read the notice" leads: the Live now view's notices section. */
		noticeHref: string;
		/** On the record, say that a current notice does not explain the historic result. */
		record: boolean;
	}

	let { locale, operator, current, noticeHref, record }: Props = $props();

	const { line } = transitDisplay();
	const uid = $props.id();
	const t = $derived(detailCopy[locale]);
	const lead = $derived(current[0] ?? null);
	const leadText = $derived(lead ? alertDisplayText(lead.alert, locale) : null);
	const leadMarker = $derived(leadText ? alertLanguageNotice(leadText, locale) : null);
	const listFormat = $derived(
		new Intl.ListFormat(locale === 'fr' ? 'fr-CA' : 'en-CA', { type: 'conjunction' }),
	);
	const leadScope = $derived(
		lead == null
			? null
			: lead.scope === 'stop'
				? t.notices.scopeStop
				: t.notices.scopeLines(lead.lines.length, listFormat.format(lead.lines.map(line))),
	);
</script>

<!-- It arrives with the live alert report, after first paint, so it sits below the record's
     answer: nothing the reader is already reading moves when it lands. -->
{#if lead && leadText}
	<aside
		class="stop-notice"
		data-slot="stop-current-notice"
		data-scope={lead.scope}
		aria-labelledby={`${uid}-notice`}
	>
		<p class="stop-notice__label" id={`${uid}-notice`}>
			{current.length === 1
				? t.notices.current(operator)
				: t.notices.currentMany(current.length, operator)}
		</p>
		<p class="stop-notice__text">
			<span lang={leadText.lang ?? undefined}>{leadText.text}</span>
			{#if leadMarker}<span class="stop-notice__marker">{leadMarker}</span>{/if}
		</p>
		<p class="stop-notice__scope">
			{record ? `${leadScope} ${t.notices.notHistoric}` : leadScope}
		</p>
		<a class="stop-notice__link" href={noticeHref}>
			{current.length === 1 ? t.notices.readOne : t.notices.readMany(current.length)}
		</a>
	</aside>
{/if}

<style>
	.stop-notice {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 0.25rem;
		padding-block: 0.75rem;
		border-block: 1px solid var(--border);
	}
	.stop-notice p {
		margin: 0;
		max-width: var(--measure-lede);
	}
	.stop-notice__label {
		font-size: var(--text-small);
		font-weight: 600;
		color: var(--foreground);
	}
	.stop-notice__text {
		font-size: var(--text-body);
		line-height: 1.45;
	}
	.stop-notice__marker {
		margin-inline-start: 0.375rem;
		color: var(--muted-foreground);
		font-size: var(--text-small);
	}
	.stop-notice__scope {
		color: var(--muted-foreground);
		font-size: var(--text-small);
		line-height: 1.5;
	}
	.stop-notice__link {
		justify-self: start;
		display: inline-flex;
		align-items: center;
		min-block-size: var(--size-tap-min);
		color: var(--primary);
		font-size: var(--text-small);
		text-decoration: underline;
		text-underline-offset: 0.2em;
	}
	.stop-notice__link:hover {
		text-decoration-thickness: 2px;
	}
	.stop-notice__link:focus-visible {
		outline: 2px solid var(--ring);
		outline-offset: 2px;
		border-radius: var(--radius-sm);
	}
</style>
