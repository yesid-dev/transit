<script lang="ts">
	import { navPillCopy } from '#lib/i18n/messages.ts';
	import { Button } from '@yesid/ui/button';
	import { cn } from '#lib/utils/index.ts';
	import { dataRefresh } from '#lib/stores/index.ts';
	import type { Locale } from '#lib/i18n/index.ts';
	import { tick, type Snippet } from 'svelte';
	import { page } from '$app/state';
	import { browserAdapterManifest } from '#lib/v1/adapter/browserManifest.ts';
	import {
		refreshResult,
		refreshMessage,
		RESULT_VISIBLE_MS,
		type RefreshResult,
	} from './refreshResult';

	interface Props {
		locale: Locale;
		class?: string;
		fixedTapTarget?: boolean;
		/** Visible content, such as a live stamp. It names the button, followed by the action. */
		children?: Snippet;
	}

	let { locale, class: className, fixedTapTarget = false, children }: Props = $props();

	const refreshing = $derived(dataRefresh.refreshing);
	let result = $state<RefreshResult | null>(null);
	let region: HTMLParagraphElement;
	let control: HTMLDivElement;
	let shift = $state(0);
	const message = $derived(
		result
			? refreshMessage(
					result,
					locale,
					page.data?.provider?.timezone ?? browserAdapterManifest()?.tz,
				)
			: '',
	);
	$effect(() => {
		if (
			refreshing ||
			(result?.kind === 'failed' &&
				dataRefresh.lastResult &&
				dataRefresh.dataAtMs > dataRefresh.lastResult.atMs)
		)
			result = null;
	});
	$effect(() => {
		if (!result || result.kind === 'failed') return;
		const timer = setTimeout(
			() => {
				result = null;
			},
			Math.max(0, RESULT_VISIBLE_MS - (Date.now() - dataRefresh.lastResult!.atMs)),
		);
		return () => clearTimeout(timer);
	});

	const label = $derived(
		refreshing
			? navPillCopy[locale].refreshing
			: dataRefresh.error
				? navPillCopy[locale].refreshFailed
				: navPillCopy[locale].refresh,
	);

	async function onClick(): Promise<void> {
		result = null;
		shift = 0;
		await dataRefresh.run();
		const completed = dataRefresh.lastResult;
		if (!completed) return;
		result = refreshResult({ ...completed, record: null });
		await tick();
		if (!region?.isConnected) return;
		const box = region.getBoundingClientRect();
		shift = Math.max(16 - box.left, Math.min(0, window.innerWidth - 16 - box.right));
	}
	function dismissPress(event: PointerEvent): void {
		if (!(event.target instanceof Node) || !control.querySelector('button')?.contains(event.target))
			result = null;
	}
</script>

<svelte:window
	onkeydowncapture={(event) => {
		if (event.key === 'Escape') result = null;
	}}
	onpointerdowncapture={dismissPress}
/>
<div bind:this={control} class={cn('refresh-control', className)} data-slot="refresh-control">
	<Button
		type="button"
		variant="ghost"
		size={children ? 'sm' : 'icon-tap'}
		class={children ? 'min-h-11 max-w-full gap-1 px-0' : undefined}
		style={fixedTapTarget ? 'width: var(--size-tap-min); height: var(--size-tap-min);' : undefined}
		aria-label={children ? undefined : label}
		title={label}
		onclick={onClick}
		disabled={refreshing}
		data-refreshing={refreshing}
		data-refresh-failed={dataRefresh.error != null}
	>
		{#if children}
			<!-- Name the button from what it shows (a live stamp keeps ticking), then the action. -->
			{@render children()}<span class="sr-only">. {label}</span>
		{/if}
		<svg
			data-motion={refreshing ? 'refresh-busy' : undefined}
			class="refresh-icon"
			class:spin={refreshing}
			class:failed={dataRefresh.error != null}
			viewBox="0 0 20 20"
			width="16"
			height="16"
			aria-hidden="true"
			fill="none"
		>
			<path
				d="M16.5 5.5A7 7 0 0 0 4 7.2M3.5 14.5A7 7 0 0 0 16 12.8"
				stroke="currentColor"
				stroke-width="1.5"
				stroke-linecap="round"
			/>
			<path
				d="M16.8 3v2.6h-2.6M3.2 17v-2.6h2.6"
				stroke="currentColor"
				stroke-width="1.5"
				stroke-linecap="round"
				stroke-linejoin="round"
			/>
		</svg>
	</Button>
	<p
		bind:this={region}
		role="status"
		data-slot="refresh-result"
		data-failed={result?.kind === 'failed'}
		style:transform={`translateX(${shift}px)`}
	>
		{#if message}{message}{/if}
	</p>
</div>

<style>
	.refresh-control {
		position: relative;
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
	}
	[data-slot='refresh-result'] {
		position: absolute;
		inset-block-start: calc(100% + 0.5rem);
		inset-inline-end: 0;
		z-index: 1;
		inline-size: max-content;
		max-inline-size: min(20rem, calc(100vw - 2rem));
		margin: 0;
		padding: 0.5rem 0.75rem;
		background: var(--popover);
		color: var(--popover-foreground);
		border: 1px solid var(--border);
		border-radius: var(--radius-lg);
		box-shadow: var(--shadow-nav);
		font-family: var(--font-body);
		font-size: var(--text-small);
		line-height: 1.4;
	}
	[data-slot='refresh-result']:empty {
		padding: 0;
		border: 0;
		box-shadow: none;
	}
	[data-slot='refresh-result'][data-failed='true'] {
		border-color: var(--accent-text);
	}

	.refresh-icon.spin {
		animation: refresh-spin 0.8s linear infinite;
		transform-origin: center;
	}
	.refresh-icon.failed {
		color: var(--accent-text);
	}
	@keyframes refresh-spin {
		to {
			transform: rotate(360deg);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.refresh-icon.spin {
			animation: none;
		}
	}
</style>
