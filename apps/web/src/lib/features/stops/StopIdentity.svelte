<script lang="ts">
	import AccessibilityIcon from '@lucide/svelte/icons/accessibility';
	import { getLocalizeHref, type Locale } from '#lib/i18n/index.ts';
	import { routeFor } from '#lib/nav/index.ts';
	import { transitDisplay } from '#lib/site/transitDisplayContext.ts';
	import { alertDisplayText, alertLanguageNotice } from '#lib/v1/alertDisplay.ts';
	import type { StopAccess, StopNotice } from './stopIdentity';
	import { detailCopy } from './stops.copy';

	interface Props {
		locale: Locale;
		/** Lines serving the stop, as published; null while the stop file is unavailable. */
		lines: readonly string[] | null;
		access: StopAccess | null;
		operator: string;
		/** Notices in effect now, those naming the stop first. */
		current: readonly StopNotice[];
		/** Where "Read the notice" leads: the Live now view's notices section. */
		noticeHref: string;
		/** On the record, say that a current notice does not explain the historic result. */
		record: boolean;
	}

	let { locale, lines, access, operator, current, noticeHref, record }: Props = $props();

	const { line } = transitDisplay();
	const uid = $props.id();
	const localizeHref = getLocalizeHref();
	const t = $derived(detailCopy[locale]);
	const accessText = $derived(
		access === 'yes'
			? t.info.wheelchairYes
			: access === 'no'
				? t.info.wheelchairNo
				: access === 'unknown'
					? t.identity.accessUnknown
					: null,
	);
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

<div class="stop-identity" data-slot="stop-identity" aria-label={t.identity.label} role="group">
	<div class="stop-identity__row">
		{#if lines && lines.length > 0}
			<div class="stop-identity__served">
				<span class="stop-identity__served-label" id={`${uid}-lines`}>{t.info.routesServed}</span>
				<ul class="stop-identity__lines" aria-labelledby={`${uid}-lines`}>
					{#each lines as route (route)}
						<li>
							<a
								class="stop-identity__line"
								href={localizeHref(routeFor({ kind: 'line', id: route }), locale)}
								aria-label={t.identity.line(line(route))}
							>
								<span class="stop-identity__plate" translate="no">{line(route)}</span>
							</a>
						</li>
					{/each}
				</ul>
			</div>
		{/if}
		{#if accessText}
			<p class="stop-identity__access" data-slot="stop-access" data-access={access}>
				<AccessibilityIcon aria-hidden="true" />
				<span class="sr-only">{t.info.wheelchair}: </span>{accessText}
			</p>
		{/if}
	</div>

	{#if lead && leadText}
		<aside
			class="stop-identity__notice"
			data-slot="stop-current-notice"
			data-scope={lead.scope}
			aria-labelledby={`${uid}-notice`}
		>
			<p class="stop-identity__notice-label" id={`${uid}-notice`}>
				{current.length === 1
					? t.notices.current(operator)
					: t.notices.currentMany(current.length, operator)}
			</p>
			<p class="stop-identity__notice-text">
				<span lang={leadText.lang ?? undefined}>{leadText.text}</span>
				{#if leadMarker}<span class="stop-identity__marker">{leadMarker}</span>{/if}
			</p>
			<p class="stop-identity__notice-scope">
				{record ? `${leadScope} ${t.notices.notHistoric}` : leadScope}
			</p>
			<a class="stop-identity__notice-link" href={noticeHref}>
				{current.length === 1 ? t.notices.readOne : t.notices.readMany(current.length)}
			</a>
		</aside>
	{/if}
</div>

<style>
	.stop-identity {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		min-width: 0;
	}
	.stop-identity__row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem 1.5rem;
		min-width: 0;
	}
	.stop-identity__served {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0 0.75rem;
		min-width: 0;
	}
	.stop-identity__served-label {
		color: var(--muted-foreground);
		font-size: var(--text-small);
	}
	.stop-identity__lines {
		display: flex;
		flex-wrap: wrap;
		gap: 0.25rem;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.stop-identity__line {
		display: inline-flex;
		align-items: center;
		min-block-size: var(--size-tap-min, 44px);
		min-inline-size: var(--size-tap-min, 44px);
		justify-content: center;
		border-radius: var(--radius-md);
		text-decoration: none;
	}
	.stop-identity__line:focus-visible {
		outline: 2px solid var(--ring);
		outline-offset: 2px;
	}
	.stop-identity__plate {
		display: inline-block;
		padding: 0.125rem 0.5rem;
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		background: var(--surface-2);
		color: var(--foreground);
		font-family: var(--font-mono);
		font-size: var(--text-small);
		font-weight: 700;
		line-height: 1.4;
	}
	.stop-identity__line:hover .stop-identity__plate {
		border-color: var(--primary);
	}
	.stop-identity__access {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		margin: 0;
		color: var(--muted-foreground);
		font-size: var(--text-small);
		line-height: 1.4;
	}
	.stop-identity__access :global(svg) {
		inline-size: 1.125rem;
		block-size: 1.125rem;
		flex: none;
	}
	.stop-identity__notice {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 0.25rem;
		padding-block: 0.75rem;
		border-block: 1px solid var(--border);
	}
	.stop-identity__notice p {
		margin: 0;
		max-width: 65ch;
	}
	.stop-identity__notice-label {
		font-size: var(--text-small);
		font-weight: 600;
		color: var(--foreground);
	}
	.stop-identity__notice-text {
		font-size: var(--text-body);
		line-height: 1.45;
	}
	.stop-identity__marker {
		margin-inline-start: 0.375rem;
		color: var(--muted-foreground);
		font-size: var(--text-small);
	}
	.stop-identity__notice-scope {
		color: var(--muted-foreground);
		font-size: var(--text-small);
		line-height: 1.5;
	}
	.stop-identity__notice-link {
		justify-self: start;
		display: inline-flex;
		align-items: center;
		min-block-size: var(--size-tap-min, 44px);
		color: var(--primary);
		font-size: var(--text-small);
		text-decoration: underline;
		text-underline-offset: 0.2em;
	}
	.stop-identity__notice-link:hover {
		text-decoration-thickness: 2px;
	}
	.stop-identity__notice-link:focus-visible {
		outline: 2px solid var(--ring);
		outline-offset: 2px;
		border-radius: var(--radius-sm);
	}
</style>
