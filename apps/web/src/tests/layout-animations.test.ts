import { afterEach, describe, expect, it, vi } from 'vitest';
import { pendingLayoutAnimations } from '../../e2e/layout-animations';

class ScrollTimeline {}
class ViewTimeline {}
const documentTimeline = {};

function animation(timeline: object | null, playState = 'running', iterations = 1) {
	return { timeline, playState, effect: { getTiming: () => ({ iterations }) } };
}

describe('pending layout animations', () => {
	afterEach(() => vi.unstubAllGlobals());

	it.each([
		['document timeline', documentTimeline],
		['no timeline', null],
	])('waits on a finite animation with the %s', (_label, timeline) => {
		vi.stubGlobal('document', {
			timeline: documentTimeline,
			getAnimations: () => [animation(timeline)],
		});
		vi.stubGlobal('ScrollTimeline', ScrollTimeline);
		vi.stubGlobal('ViewTimeline', ViewTimeline);

		expect(pendingLayoutAnimations()).toBe(1);
	});

	it('ignores scroll and view timelines, finished motion and unbounded loops', () => {
		vi.stubGlobal('document', {
			timeline: documentTimeline,
			getAnimations: () => [
				animation(new ScrollTimeline()),
				animation(new ViewTimeline()),
				animation(documentTimeline, 'finished'),
				animation(documentTimeline, 'running', Infinity),
			],
		});
		vi.stubGlobal('ScrollTimeline', ScrollTimeline);
		vi.stubGlobal('ViewTimeline', ViewTimeline);

		expect(pendingLayoutAnimations()).toBe(0);
	});
});
