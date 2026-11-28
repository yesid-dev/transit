// One layout for the notice filters and their waiting skeleton, so nothing moves when they swap.
export const alertFilterLayout = {
	bar: 'flex min-w-0 flex-wrap items-end gap-x-4 gap-y-3',
	field: 'grid min-w-0 max-w-[22rem] flex-[1_1_12rem] gap-1',
	wideField: 'grid min-w-0 flex-[1_1_24rem] gap-1',
	summary: 'ms-auto flex flex-wrap items-center gap-x-3 gap-y-2 text-small',
} as const;
