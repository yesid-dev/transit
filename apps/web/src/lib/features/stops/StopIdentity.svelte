<script lang="ts">
	import AccessibilityIcon from '@lucide/svelte/icons/accessibility';
	import { getLocalizeHref, type Locale } from '#lib/i18n/index.ts';
	import { routeFor } from '#lib/nav/index.ts';
	import { transitDisplay } from '#lib/site/transitDisplayContext.ts';
	import type { StopAccess } from './stopIdentity';
	import { detailCopy } from './stops.copy';

	interface Props {
		locale: Locale;
		/** Lines serving the stop, as published; null while the stop file is unavailable. */
		lines: readonly string[] | null;
		/** Null while the stop file loads. */
		access: StopAccess | null;
	}

	let { locale, lines, access }: Props = $props();

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
	// Nothing is known yet: the row holds a typical row's room so its arrival moves nothing below.
	const pending = $derived(lines == null && access == null);
</script>

<div class="stop-identity" data-slot="stop-identity" aria-label={t.identity.label} role="group">
	<div class="stop-identity__row">
		{#if pending}
			<!-- An unseen one-line row with an access note holds the room, wrapping as one would. -->
			<div class="stop-identity__served stop-identity__held" aria-hidden="true">
				<span class="stop-identity__served-label">{t.info.routesServed}</span>
				<span class="stop-identity__line"><span class="stop-identity__plate">000</span></span>
			</div>
			<p class="stop-identity__access stop-identity__held" aria-hidden="true">
				<AccessibilityIcon />{t.info.wheelchairNo}
			</p>
		{/if}
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
	.stop-identity__held {
		visibility: hidden;
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
		min-block-size: var(--size-tap-min);
		min-inline-size: var(--size-tap-min);
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
</style>
