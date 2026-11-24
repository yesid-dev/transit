export interface FocusPosition {
	region: string;
	group: number;
	groupParent?: number;
	groupLeft: number;
	groupTop: number;
	left: number;
	top: number;
	bottom: number;
}

export function focusOutOfOrder(prior: FocusPosition, next: FocusPosition): boolean {
	if (prior.region !== next.region || next.region === 'other') return false;
	const movesBackward =
		next.bottom <= prior.top || (Math.abs(next.top - prior.top) <= 2 && next.left < prior.left - 2);
	const crossesGroups =
		prior.group >= 0 &&
		next.group >= 0 &&
		prior.group !== next.group &&
		prior.groupParent !== next.group &&
		next.groupParent !== prior.group;
	if (!crossesGroups) return movesBackward;

	// Read a column to its end, then allow the next group to start higher on the right.
	if (next.groupLeft > prior.groupLeft + 2) return false;
	return (
		movesBackward ||
		next.groupTop < prior.groupTop - 2 ||
		(Math.abs(next.groupTop - prior.groupTop) <= 2 && next.groupLeft < prior.groupLeft - 2)
	);
}
