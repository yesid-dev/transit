/** Count running finite animations that can settle while the page stays still. */
export function pendingLayoutAnimations(): number {
	return document.getAnimations().filter((animation) => {
		const { timeline } = animation;
		const usesScroll =
			(typeof ScrollTimeline !== 'undefined' && timeline instanceof ScrollTimeline) ||
			(typeof ViewTimeline !== 'undefined' && timeline instanceof ViewTimeline);
		return (
			!usesScroll &&
			animation.playState === 'running' &&
			animation.effect?.getTiming().iterations !== Infinity
		);
	}).length;
}
