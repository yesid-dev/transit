const GLYPH_ROOT = '/map/glyphs/028c18f';

export const BASEMAP_GLYPHS_URL = `${GLYPH_ROOT}/{fontstack}/{range}.pbf`;

export const INITIAL_MAP_GLYPHS = ['Noto Sans Medium', 'Noto Sans Regular'].map(
	(font) => `${GLYPH_ROOT}/${encodeURIComponent(font)}/0-255.pbf`,
);
