import type { Map as MapLibreMap } from 'maplibre-gl';
import {
	STATUS_CODES,
	OCCUPANCY_CODES,
	type StatusCode,
	type OccupancyCode,
} from '#lib/v1/schemas/types.ts';
import { occupancyGlyph, occupancyVar, statusVar } from '#lib/components/dataviz/tokens.ts';

export const VEHICLE_MARKER_GEOMETRY = Object.freeze({
	box: 26,
	bodyIconSize: Object.freeze({ z11: 0.78, z15: 1.3 }),
	headingOffset: Object.freeze([0, -9] as const),
	stateBadge: Object.freeze({
		offset: Object.freeze([0, 30] as const),
		pairedOffset: Object.freeze([-9, 30] as const),
		scale: 0.6,
	}),
	silentBadge: Object.freeze({
		offset: Object.freeze([0, 30] as const),
		pairedOffset: Object.freeze([9, 30] as const),
		scale: 0.75,
	}),
	chevronAnnulus: Object.freeze({ inner: 12.7, outer: 19.8 }),
	plateMargin: 2.4,
});

const SIZE = VEHICLE_MARKER_GEOMETRY.box;
const RATIO =
	typeof window !== 'undefined' ? Math.max(2, Math.ceil(window.devicePixelRatio || 1)) : 2;

export const VEHICLE_ICON = 'veh-unknown';
export const HEADING_ICON = 'veh-heading';
export const SILENT_ICON = 'veh-silent';
export const STOP_ICON = 'veh-stop';

export const VEHICLE_FILL_TOKEN = 'var(--primary)';
export const VEHICLE_FILL_FALLBACK = 'rgb(224, 120, 0)';
export const VEHICLE_HALO_TOKEN = 'var(--background)';
export const VEHICLE_HALO_FALLBACK = '#141414';
export const STOP_FILL_TOKEN = 'var(--map-stop-fill)';
export const STOP_FILL_FALLBACK = 'rgb(255, 182, 39)';
export const STOP_HALO_TOKEN = VEHICLE_HALO_TOKEN;
export const HEADING_FILL_TOKEN = 'var(--foreground)';
export const HEADING_HALO_TOKEN = VEHICLE_HALO_TOKEN;
export const SILENT_FILL_TOKEN = 'var(--foreground)';
export const SILENT_FILL_FALLBACK = '#f5f5f5';
export const SILENT_HALO_TOKEN = 'var(--background)';

export function mapOccupancyColour(code: OccupancyCode) {
	return `color-mix(in srgb, ${occupancyVar(code)}, var(--foreground) 45%)`;
}

export function resolveColor(varExpr: string, fallback: string): string {
	if (typeof document === 'undefined') return fallback;
	const probe = document.createElement('span');
	probe.style.cssText = `position:absolute;visibility:hidden;color:${varExpr}`;
	document.body.appendChild(probe);
	const c = getComputedStyle(probe).color;
	probe.remove();
	return c || fallback;
}

function spriteContext(): CanvasRenderingContext2D {
	const px = SIZE * RATIO;
	const cv = document.createElement('canvas');
	cv.width = px;
	cv.height = px;
	const ctx = cv.getContext('2d');
	if (!ctx) throw new Error('[vehicleSprites] 2D canvas context unavailable');
	ctx.scale(RATIO, RATIO);
	return ctx;
}

function roundedRect(
	ctx: CanvasRenderingContext2D,
	x: number,
	y: number,
	w: number,
	h: number,
	r: number,
): void {
	const rr = Math.min(r, w / 2, h / 2);
	ctx.beginPath();
	ctx.moveTo(x + rr, y);
	ctx.arcTo(x + w, y, x + w, y + h, rr);
	ctx.arcTo(x + w, y + h, x, y + h, rr);
	ctx.arcTo(x, y + h, x, y, rr);
	ctx.arcTo(x, y, x + w, y, rr);
	ctx.closePath();
}

function vehicleCanvas(fill: string, halo: string): HTMLCanvasElement {
	const ctx = spriteContext();
	ctx.lineJoin = 'round';
	const x = 6.5;
	const y = 3.5;
	const width = SIZE - x * 2;
	const height = SIZE - y * 2;
	roundedRect(ctx, x, y, width, height, 4);
	ctx.fillStyle = fill;
	ctx.fill();
	ctx.lineWidth = 2;
	ctx.strokeStyle = halo;
	ctx.stroke();

	const inset = 2.4;
	roundedRect(ctx, x + inset, y + inset, width - inset * 2, 5.6, 2);
	ctx.fillStyle = halo;
	ctx.fill();
	for (const headlight of [x + inset + 1.2, x + width - inset - 1.2]) {
		ctx.beginPath();
		ctx.arc(headlight, SIZE - y - 3.4, 1.15, 0, Math.PI * 2);
		ctx.fill();
	}
	return ctx.canvas;
}

function stopPinCanvas(fill: string, halo: string): HTMLCanvasElement {
	const ctx = spriteContext();
	ctx.lineJoin = 'round';
	ctx.lineCap = 'round';
	const c = SIZE / 2;

	const headY = c - 2.5;
	const headR = 6.6;
	const tipY = SIZE - 3.5;
	ctx.beginPath();
	ctx.moveTo(c, tipY);
	ctx.bezierCurveTo(
		c - headR * 0.92,
		headY + headR * 0.7,
		c - headR,
		headY,
		c - headR,
		headY - 0.5,
	);
	ctx.arc(c, headY, headR, Math.PI, 0, false);
	ctx.bezierCurveTo(c + headR, headY, c + headR * 0.92, headY + headR * 0.7, c, tipY);
	ctx.closePath();
	ctx.fillStyle = fill;
	ctx.fill();
	ctx.lineWidth = 2;
	ctx.strokeStyle = halo;
	ctx.stroke();

	ctx.beginPath();
	ctx.arc(c, headY, 2.5, 0, Math.PI * 2);
	ctx.fillStyle = halo;
	ctx.fill();

	return ctx.canvas;
}

function chevronCanvas(fill: string, halo: string): HTMLCanvasElement {
	const ctx = spriteContext();
	const c = SIZE / 2;
	ctx.lineJoin = 'round';
	ctx.lineCap = 'round';
	ctx.beginPath();
	ctx.moveTo(c, 3);
	ctx.lineTo(c + 5, 9.5);
	ctx.lineTo(c, 7.3);
	ctx.lineTo(c - 5, 9.5);
	ctx.closePath();
	ctx.fillStyle = fill;
	ctx.fill();
	ctx.lineWidth = 1.6;
	ctx.strokeStyle = halo;
	ctx.stroke();
	return ctx.canvas;
}

function silentBadgeCanvas(fill: string, halo: string): HTMLCanvasElement {
	const ctx = spriteContext();
	ctx.lineJoin = 'round';
	ctx.lineCap = 'round';

	const cx = SIZE / 2;
	const cy = SIZE / 2;

	const margin = VEHICLE_MARKER_GEOMETRY.plateMargin;
	const side = SIZE - margin * 2;
	roundedRect(ctx, margin, margin, side, side, side * 0.28);
	ctx.fillStyle = fill;
	ctx.fill();
	ctx.lineWidth = 2;
	ctx.strokeStyle = halo;
	ctx.stroke();

	ctx.strokeStyle = halo;
	ctx.lineWidth = SIZE * 0.16;
	ctx.beginPath();
	ctx.moveTo(cx, cy - side * 0.3);
	ctx.lineTo(cx, cy + side * 0.07);
	ctx.stroke();

	ctx.beginPath();
	ctx.arc(cx, cy + side * 0.28, SIZE * 0.085, 0, Math.PI * 2);
	ctx.fillStyle = halo;
	ctx.fill();

	return ctx.canvas;
}

export const statusBodyIconId = (code: StatusCode): string => `veh-s-${code}`;

export const occupancyBodyIconId = (status: StatusCode, occupancy: OccupancyCode): string =>
	`veh-o-${occupancy}-${status}`;

export const occupancyBadgeIconId = (code: OccupancyCode): string => `veh-m-o-${code}`;

export type StateBadgeReceipt = Readonly<{
	stateBadges: Readonly<Record<string, number>>;
	stateBadgeImages: Readonly<Record<string, ImageData>>;
	stateGlyphMasks: Readonly<Record<string, number>>;
	stateGlyphMaskImages: Readonly<Record<string, ImageData>>;
}>;

export type VehicleSpriteReceipt = StateBadgeReceipt &
	Readonly<{
		sprites: Readonly<Record<string, ImageData>>;
		pixelRatio: number;
	}>;

export function countStateBadgePaintedPixels(image: ImageData): number {
	if (image.width !== image.height || image.width % SIZE !== 0) {
		throw new Error('[vehicleSprites] state badge image must be a square 26px DPR multiple');
	}
	const ratio = image.width / SIZE;
	let opaquePixels = 0;
	for (let index = 3; index < image.data.length; index += 4) {
		if (image.data[index] > 0) opaquePixels += 1;
	}
	return Number(
		((opaquePixels / ratio ** 2) * VEHICLE_MARKER_GEOMETRY.stateBadge.scale ** 2).toFixed(6),
	);
}

function drawStateGlyph(ctx: CanvasRenderingContext2D, glyph: string, paint: string): void {
	const side = SIZE - VEHICLE_MARKER_GEOMETRY.plateMargin * 2;
	const left = VEHICLE_MARKER_GEOMETRY.plateMargin;
	const top = left;
	ctx.fillStyle = paint;

	if (glyph === occupancyGlyph('full')) {
		const inset = 2.8;
		const near = Math.round((left + inset) * 10) / 10;
		const far = Math.round((left + side - inset) * 10) / 10;
		ctx.strokeStyle = paint;
		ctx.lineWidth = 2.4;
		ctx.beginPath();
		ctx.moveTo(near, near);
		ctx.lineTo(far, near);
		ctx.lineTo(far, far);
		ctx.lineTo(near, far);
		ctx.closePath();
		ctx.stroke();
		ctx.beginPath();
		ctx.moveTo(near, near);
		ctx.lineTo(far, far);
		ctx.moveTo(far, near);
		ctx.lineTo(near, far);
		ctx.stroke();
		return;
	}

	let occupancyHeight: number;
	if (glyph === occupancyGlyph('empty')) occupancyHeight = 0.12;
	else if (glyph === occupancyGlyph('many_seats')) occupancyHeight = 0.28;
	else if (glyph === occupancyGlyph('few_seats')) occupancyHeight = 0.45;
	else if (glyph === occupancyGlyph('standing')) occupancyHeight = 0.62;
	else throw new Error(`[vehicleSprites] unrecognized state glyph: ${glyph}`);
	const h = side * occupancyHeight;
	roundedRect(ctx, left + side * 0.2, top + side * 0.78 - h, side * 0.6, h, Math.min(1.2, h / 2));
	ctx.fill();
}

function stateBadgeCanvas(glyph: string, fill: string, halo: string): HTMLCanvasElement {
	const ctx = spriteContext();
	ctx.lineJoin = 'round';
	ctx.lineCap = 'round';

	const margin = VEHICLE_MARKER_GEOMETRY.plateMargin;
	const side = SIZE - margin * 2;
	roundedRect(ctx, margin, margin, side, side, side * 0.28);
	ctx.fillStyle = fill;
	ctx.fill();
	ctx.lineWidth = 2;
	ctx.strokeStyle = halo;
	ctx.stroke();
	drawStateGlyph(ctx, glyph, halo);

	return ctx.canvas;
}

function stateGlyphMaskCanvas(glyph: string, fill: string): HTMLCanvasElement {
	const ctx = spriteContext();
	ctx.lineJoin = 'round';
	ctx.lineCap = 'round';
	drawStateGlyph(ctx, glyph, fill);
	return ctx.canvas;
}

export function bakeVehicleSprites(
	map: MapLibreMap,
	registerVehicleImages = true,
): VehicleSpriteReceipt {
	const background = resolveColor(VEHICLE_HALO_TOKEN, VEHICLE_HALO_FALLBACK);
	const forced = window.matchMedia('(forced-colors: active)').matches;
	// Canvas keeps its pixels when the browser forces DOM colours. Resolve an explicit
	// system-colour pair so the plate and the glyph do not both resolve to CanvasText.
	const forcedFill = forced ? resolveColor('CanvasText', '#000') : null;
	const vehicleHalo = forced ? resolveColor('Canvas', '#fff') : background;
	const vehicleFill = (token: string, fallback: string) =>
		forcedFill ?? resolveColor(token, fallback);
	const foreground = vehicleFill(SILENT_FILL_TOKEN, SILENT_FILL_FALLBACK);
	const canvases: HTMLCanvasElement[] = [];
	const sprites: { id: string; index: number }[] = [];
	const badges: { id: string; image: number; mask: number }[] = [];
	const queue = (canvas: HTMLCanvasElement): number => canvases.push(canvas) - 1;
	const add = (id: string, canvas: HTMLCanvasElement): number => {
		const index = queue(canvas);
		sprites.push({ id, index });
		return index;
	};

	for (const status of STATUS_CODES) {
		add(
			statusBodyIconId(status),
			vehicleCanvas(vehicleFill(statusVar(status), '#8a8a8a'), vehicleHalo),
		);
	}
	for (const occupancy of OCCUPANCY_CODES) {
		const fill = vehicleFill(mapOccupancyColour(occupancy), '#7a5fb0');
		for (const status of STATUS_CODES) {
			add(occupancyBodyIconId(status, occupancy), vehicleCanvas(fill, vehicleHalo));
		}
	}
	for (const code of OCCUPANCY_CODES as readonly OccupancyCode[]) {
		const id = occupancyBadgeIconId(code);
		const glyph = occupancyGlyph(code);
		badges.push({
			id,
			image: add(id, stateBadgeCanvas(glyph, foreground, vehicleHalo)),
			mask: queue(stateGlyphMaskCanvas(glyph, vehicleHalo)),
		});
	}
	add(
		VEHICLE_ICON,
		vehicleCanvas(vehicleFill(VEHICLE_FILL_TOKEN, VEHICLE_FILL_FALLBACK), vehicleHalo),
	);
	add(HEADING_ICON, chevronCanvas(foreground, vehicleHalo));
	add(SILENT_ICON, silentBadgeCanvas(foreground, vehicleHalo));
	add(STOP_ICON, stopPinCanvas(resolveColor(STOP_FILL_TOKEN, STOP_FILL_FALLBACK), background));

	const images = readSpriteCanvases(canvases);
	const stateBadges: Record<string, number> = {};
	const stateBadgeImages: Record<string, ImageData> = {};
	const stateGlyphMasks: Record<string, number> = {};
	const stateGlyphMaskImages: Record<string, ImageData> = {};
	const spriteImages: Record<string, ImageData> = {};
	for (const { id, image, mask } of badges) {
		stateBadgeImages[id] = images[image];
		stateGlyphMaskImages[id] = images[mask];
		stateBadges[id] = countStateBadgePaintedPixels(images[image]);
		stateGlyphMasks[id] = countStateBadgePaintedPixels(images[mask]);
	}
	for (const { id, index } of sprites) {
		spriteImages[id] = images[index];
		if (id !== STOP_ICON && !registerVehicleImages) continue;
		if (map.hasImage(id)) map.removeImage(id);
		map.addImage(id, images[index], { pixelRatio: RATIO });
	}
	return Object.freeze({
		stateBadges: Object.freeze(stateBadges),
		stateBadgeImages: Object.freeze(stateBadgeImages),
		stateGlyphMasks: Object.freeze(stateGlyphMasks),
		stateGlyphMaskImages: Object.freeze(stateGlyphMaskImages),
		sprites: Object.freeze(spriteImages),
		pixelRatio: RATIO,
	});
}

function readSpriteCanvases(canvases: readonly HTMLCanvasElement[]): ImageData[] {
	const px = SIZE * RATIO;
	const atlas = document.createElement('canvas');
	atlas.width = px;
	atlas.height = px * canvases.length;
	const ctx = atlas.getContext('2d');
	if (!ctx) throw new Error('[vehicleSprites] 2D canvas context unavailable');
	canvases.forEach((canvas, index) => ctx.drawImage(canvas, 0, index * px));
	const { data } = ctx.getImageData(0, 0, px, atlas.height);
	const bytes = px * px * 4;
	return canvases.map(
		(_, index) => new ImageData(data.slice(index * bytes, (index + 1) * bytes), px, px),
	);
}
