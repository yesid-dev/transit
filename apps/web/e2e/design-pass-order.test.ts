import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { focusOutOfOrder } from './design-pass-order';

test('grouped Tab order reads down each column and advances to the right', () => {
	const left = {
		region: 'main',
		group: 0,
		groupLeft: 100,
		groupTop: 200,
		left: 100,
		top: 900,
		bottom: 940,
	};
	const right = {
		region: 'main',
		group: 1,
		groupLeft: 500,
		groupTop: 200,
		left: 500,
		top: 350,
		bottom: 390,
	};
	assert.equal(focusOutOfOrder(left, right), false);
	assert.equal(focusOutOfOrder(right, left), true);
	assert.equal(focusOutOfOrder(left, { ...right, groupLeft: 100, groupTop: 150 }), true);
	assert.equal(focusOutOfOrder(left, { ...right, groupLeft: 500, groupTop: 150 }), false);
	assert.equal(focusOutOfOrder(left, { ...left, top: 800, bottom: 840 }), true);
	assert.equal(
		focusOutOfOrder(left, { ...right, groupLeft: 100, groupTop: 1000, top: 1100, bottom: 1140 }),
		false,
	);
});
