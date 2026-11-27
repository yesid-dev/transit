import type { SheetContentProps } from '@yesid/ui/sheet';
import { MediaQuery } from 'svelte/reactivity';

export function actionSheetLayout() {
	const viewport = new MediaQuery('min-width: 768px');
	let openedByPointer = $state(false);

	return {
		trigger: {
			onclick(event: MouseEvent) {
				openedByPointer = event.detail > 0;
			},
			onkeydown(event: KeyboardEvent) {
				if (event.key === 'Enter' || event.key === ' ') openedByPointer = false;
			},
		},
		get centered() {
			return viewport.current;
		},
		get side(): SheetContentProps['side'] {
			return { base: 'bottom', md: 'center' };
		},
		/**
		 * A centred window takes focus on its title. Focus waits for the window's first frame: focusing
		 * forces style and layout, and doing it in the opening task held back the window's fade.
		 */
		focusTitle(event: Event, title: HTMLElement | null | undefined) {
			if (!viewport.current || !title) return;
			event.preventDefault();
			requestAnimationFrame(() =>
				requestAnimationFrame(() => {
					if (title.isConnected) title.focus({ preventScroll: true });
				}),
			);
		},
		get titleClass() {
			if (!viewport.current) return undefined;
			// Programmatic focus can inherit :focus-visible from the previously focused element.
			return openedByPointer ? 'w-fit text-lg focus-visible:outline-none!' : 'w-fit text-lg';
		},
	};
}
