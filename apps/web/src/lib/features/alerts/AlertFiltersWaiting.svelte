<script lang="ts">
	import type { Awaitable } from '#lib/site/ready.ts';
	import { ControlsRail } from '@yesid/ui/layout';
	import { Skeleton } from '@yesid/ui/skeleton';
	import type { Locale } from '#lib/i18n/index.ts';
	import type { EngineResult, RecordAnswer } from '#lib/server/engine.ts';
	import { recordAlertCards } from './alertCards.ts';

	let { messages, locale }: { messages?: Awaitable<EngineResult<RecordAnswer>>; locale: Locale } =
		$props();
	const t = (en: string, fr: string) => (locale === 'fr' ? fr : en);
</script>

{#snippet filters()}
	<ControlsRail label={t('Filter', 'Filtrer')} aria-hidden="true" aria-busy="true">
		<div class="grid w-full min-w-0 gap-3">
			{#each [t('Line', 'Ligne'), t('Stop', 'Arrêt')] as label (label)}
				<div class="grid min-w-0 gap-1">
					<p class="text-small text-muted-foreground">{label}</p>
					<Skeleton class="h-11 w-full" />
				</div>
			{/each}
			<div class="flex min-w-0 items-center justify-between gap-x-2">
				<Skeleton class="h-4 w-20" />
				<Skeleton class="h-11 w-12" />
			</div>
		</div>
	</ControlsRail>
{/snippet}

{#await messages}
	{@render filters()}
{:then result}
	{#if !result || (result.kind === 'answer' && 'value' in result.answer && result.answer.state === 'measured' && result.answer.value.alerts !== 0 && recordAlertCards(result.answer.evidence.alert_messages ?? []).some(({ routes, stops, effect }) => routes.length || stops.length || effect))}
		<!-- Keep the slot until the notice list has registered its live controls. -->
		{@render filters()}
	{/if}
{/await}
