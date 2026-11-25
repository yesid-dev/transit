// Existing uses are counted per file so removing a line cannot create room for a future one.
const PAGE_DRAWN_DIVIDER =
	/(?:\bborder-(?:[tby](?:-[\w.[\]%-]+)?(?![\w-])|block[\w-]*\s*:|(?:top|bottom)(?:-(?:color|style|width))?\s*:)|\bdivide-y(?:-[\w.[\]%-]+)?(?![\w-])|<hr(?=[\s/>]))/g;

export function pageDrawnDividers(source: string) {
	return source.split(/\r?\n/).flatMap((line, index) =>
		Array.from(line.matchAll(PAGE_DRAWN_DIVIDER), ([token]) => ({
			line: index + 1,
			token,
		})),
	);
}
