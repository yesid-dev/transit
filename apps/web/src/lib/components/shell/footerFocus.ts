/** Frames to follow a focused footer control while the ground above it opens. */
const MAX_FRAMES = 30;
/** Frames in a row the control must stay in view before it is left alone. */
const STEADY_FRAMES = 3;

/**
 * Keep a control focused in the footer on screen (WCAG 2.4.11). On the homepage the construction
 * ground grows above the footer as it scrolls in, so the browser's own scroll to a newly focused
 * footer link opens the ground and pushes that link back below the viewport. Follow it, frame by
 * frame, until it stays in view or focus moves on. Pages without the ground are left alone.
 */
export function keepFooterFocusInView(
	event: FocusEvent,
	frame: (callback: () => void) => unknown = requestAnimationFrame,
) {
	const target = event.target;
	if (!(target instanceof HTMLElement)) return;
	if (!document.querySelector('.home-construction-floor')) return;
	let frames = MAX_FRAMES;
	let steady = 0;
	const follow = () => {
		if (document.activeElement !== target || frames-- <= 0) return;
		const { top, bottom } = target.getBoundingClientRect();
		if (top >= 0 && bottom <= document.documentElement.clientHeight) {
			if (++steady >= STEADY_FRAMES) return;
		} else {
			steady = 0;
			target.scrollIntoView({ block: 'nearest' });
		}
		frame(follow);
	};
	frame(follow);
}
