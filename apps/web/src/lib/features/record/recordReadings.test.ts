import { expect, it } from 'vitest';
import { readingName, readingPaths, withReadings } from './recordReadings.ts';

const busy = Promise.resolve({ kind: 'busy' });
const answer = Promise.resolve({ kind: 'answer' });

function record() {
	const shared = Promise.resolve({ kind: 'busy' });
	return {
		period: { from: '2026-11-17', to: '2026-11-23' },
		city: 'demo',
		sections: [
			{ section: 'punctuality', answer: shared },
			{ section: 'delay', answer: shared },
			{ section: 'byLine', answer },
		],
		scorecard: { poll_success: busy },
		network: answer,
		grid: null,
	};
}

it('finds every reading by its place, sections by their name', () => {
	const root = record();
	expect([...readingPaths(root).keys()]).toEqual([
		'sections.punctuality',
		'sections.delay',
		'sections.byLine',
		'scorecard.poll_success',
		'network',
	]);
	expect(readingName('scorecard.poll_success')).toBe('poll_success');
	expect(readingName('network')).toBe('network');
});

it('replaces only the readings asked again and keeps everything else as it was', () => {
	const root = record();
	const arrived = Promise.resolve({ kind: 'answer' });
	const next = withReadings(
		root,
		new Map([
			['sections.delay', arrived],
			['scorecard.poll_success', arrived],
		]),
	);
	expect(next).not.toBe(root);
	expect(next.period).toBe(root.period);
	expect(next.network).toBe(root.network);
	expect(next.sections[0]).toBe(root.sections[0]);
	expect(next.sections[1]).toEqual({ section: 'delay', answer: arrived });
	expect(next.sections[2]).toBe(root.sections[2]);
	expect(next.scorecard.poll_success).toBe(arrived);
	expect(withReadings(root, new Map())).toBe(root);
});
