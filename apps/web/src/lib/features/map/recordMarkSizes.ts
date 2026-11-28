/** Record mark sizes in CSS pixels, by good-to-bad step. No imports: e2e specs read them too. */
export const recordStopRadii = {
	/** Under zoom 11 the whole network is on screen: small dots, worst largest, no ring. */
	overview: [2, 2.25, 2.5, 2.75, 3],
	network: [3.75, 4.5, 5.25, 6.25, 7.25],
	detail: [4.5, 5.5, 6.5, 7.75, 9],
	waitsNetwork: [1.5, 1.75, 2, 2.25, 2.75],
} as const;

export const recordCorridorWidths = {
	network: [2.5, 3, 3.75, 4.5, 5.5],
	detail: [2, 3, 4, 5.5, 7],
} as const;

export const recordUnmeasuredLine = {
	width: 2,
	dashes: [
		[1, 1.8],
		[3, 1.5],
		[5, 3],
	],
} as const;
