const lightness = [86, 71, 56, 41, 26] as const;
const darkLightness = [...lightness].reverse();

function sequentialRamp(anchor: string, chroma: number) {
	const paint = (level: number) => `lch(from var(${anchor}) ${level} ${chroma} h)`;
	return lightness.map(
		(level, index) => `light-dark(${paint(level)}, ${paint(darkLightness[index]!)})`,
	);
}

/** Colours follow the kit's current colour scheme. Position always runs from low to high. */
export const measureRamps = {
	lateShare: sequentialRamp('--map-late-share-anchor', 28),
	timeLost: sequentialRamp('--map-time-lost-anchor', 25),
	crowding: sequentialRamp('--dataviz-occupancy-few-seats', 26),
};

export const measureRampInk = [
	'var(--foreground)',
	'var(--foreground)',
	'light-dark(var(--foreground), var(--background))',
	'var(--background)',
	'var(--background)',
] as const;
