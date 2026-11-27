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
		get titleClass() {
			if (!viewport.current) return undefined;
			// Programmatic focus can inherit :focus-visible from the previously focused element.
			return openedByPointer ? 'w-fit text-lg focus-visible:outline-none!' : 'w-fit text-lg';
		},
	};
}
