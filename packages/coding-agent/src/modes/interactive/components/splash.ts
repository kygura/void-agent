import { type Component, type TUI, truncateToWidth, visibleWidth } from "@void/tui";
import { APP_NAME } from "../../../config.js";
import { theme } from "../theme/theme.js";

export const FRAME_INTERVAL_MS = 90;
export const MIN_WIDTH = 30;
export const MIN_HEIGHT = 11;
export const MAX_WIDTH = 60;
export const MAX_HEIGHT = 22;
export const WORDMARK_ENTRANCE_MS = 900;

const WORDMARK_TRAVEL_MS = WORDMARK_ENTRANCE_MS;
const ROTATION_FREQUENCY = 0.7;
const ROTATION_DAMPING = 0.8;
const SETTLE_POSITION = 0.01;
const SETTLE_VELOCITY = 0.05;
const MAX_DELTA_SECONDS = 0.25;
const MODEL_TILT = 0.52;
const SCALE = 0.8;
const VIEW_RADIUS = 2;
const BACKGROUND_DEPTH_BIAS = 100;

type Vec3 = { x: number; y: number; z: number };
type Point = { x: number; y: number };
type AxisSpring = { angle: number; velocity: number; target: number };
export type SplashBandStyle = (text: string) => string;

type SplashPalette = {
	name: string;
	bands: Array<{ hex: string; bold?: boolean }>;
};

type CompiledSplashPalette = {
	bands: SplashBandStyle[];
	header: SplashBandStyle;
};

// Curated splash palettes. Each is a coherent dark -> bright shading ramp
// mapping to the pyramid's six luminance levels; this same ramp drives the
// reasoning-level gauge (getActiveSplashBandStyles). One palette is picked at
// random per splash (new/clear). The amber ramp is the original Go void
// splash palette.
const SPLASH_PALETTES: SplashPalette[] = [
	{
		// amber: ember -> rust -> soft red -> amber -> yellow -> pale highlight
		name: "amber",
		bands: [
			{ hex: "#7A2E1C" },
			{ hex: "#B23B24" },
			{ hex: "#E0522A" },
			{ hex: "#FF8A34" },
			{ hex: "#FFC247", bold: true },
			{ hex: "#FFF0B2", bold: true },
		],
	},
	{
		// green: moss -> leaf -> spring -> mint highlight
		name: "green",
		bands: [
			{ hex: "#144A2C" },
			{ hex: "#1D793F" },
			{ hex: "#2DAF55" },
			{ hex: "#64E17A" },
			{ hex: "#A4F5A2", bold: true },
			{ hex: "#E1FFDB", bold: true },
		],
	},
	{
		// blue: midnight -> steel -> sky -> ice highlight
		name: "blue",
		bands: [
			{ hex: "#162A66" },
			{ hex: "#214C9A" },
			{ hex: "#2D78CC" },
			{ hex: "#56B7F0" },
			{ hex: "#A6E2FF", bold: true },
			{ hex: "#E4FAFF", bold: true },
		],
	},
	{
		// red: maroon -> brick -> coral -> blush highlight
		name: "red",
		bands: [
			{ hex: "#64152D" },
			{ hex: "#9D1E3D" },
			{ hex: "#D32F52" },
			{ hex: "#F05B69" },
			{ hex: "#FF9B9B", bold: true },
			{ hex: "#FFD0D0", bold: true },
		],
	},
	{
		// violet: plum -> orchid -> lavender highlight
		name: "violet",
		bands: [
			{ hex: "#35105F" },
			{ hex: "#5D1FA0" },
			{ hex: "#8A36D1" },
			{ hex: "#B95DEB" },
			{ hex: "#D5A1FF", bold: true },
			{ hex: "#F1DDFF", bold: true },
		],
	},
	{
		// cyan: deep teal -> cyan -> frosted aqua highlight
		name: "cyan",
		bands: [
			{ hex: "#06495A" },
			{ hex: "#08758A" },
			{ hex: "#0BA3B5" },
			{ hex: "#29D0D4" },
			{ hex: "#86F0E8", bold: true },
			{ hex: "#D5FFF5", bold: true },
		],
	},
	{
		// pink: wine -> fuchsia -> rosewater highlight
		name: "pink",
		bands: [
			{ hex: "#591440" },
			{ hex: "#8D1C63" },
			{ hex: "#C42B88" },
			{ hex: "#ED5CAE" },
			{ hex: "#FFADD6", bold: true },
			{ hex: "#FFE0EF", bold: true },
		],
	},
	{
		// teal: forest -> sea green -> seafoam highlight
		name: "teal",
		bands: [
			{ hex: "#0C473F" },
			{ hex: "#117264" },
			{ hex: "#1BA58C" },
			{ hex: "#4DD0AE" },
			{ hex: "#9DE8C9", bold: true },
			{ hex: "#D9FCEC", bold: true },
		],
	},
	{
		// gold: umber -> ochre -> sunlit cream highlight
		name: "gold",
		bands: [
			{ hex: "#5A3B0B" },
			{ hex: "#8A5B0A" },
			{ hex: "#BD8614" },
			{ hex: "#E9BC3E" },
			{ hex: "#F8DD83", bold: true },
			{ hex: "#FFF5C8", bold: true },
		],
	},
	{
		// slate: charcoal -> steel -> silver highlight
		name: "slate",
		bands: [
			{ hex: "#263340" },
			{ hex: "#405463" },
			{ hex: "#617887" },
			{ hex: "#91AAB7" },
			{ hex: "#C6D8DF", bold: true },
			{ hex: "#EDF7F8", bold: true },
		],
	},
];

export const SPLASH_PALETTE_RANDOM = "random";

// When set to a palette name, every splash uses it; "random"/unset keeps
// the pick-per-splash behavior.
let preferredPaletteName: string | undefined;

function pickSplashPalette(): SplashPalette {
	const preferred = SPLASH_PALETTES.find((palette) => palette.name === preferredPaletteName);
	if (preferred) return preferred;
	return SPLASH_PALETTES[Math.floor(Math.random() * SPLASH_PALETTES.length)] as SplashPalette;
}

function compileSplashPalette(palette: SplashPalette): CompiledSplashPalette {
	const bands = palette.bands.map((band) => styleForHex(band.hex, band.bold));
	return {
		bands,
		header: styleForHex(palette.bands[3]!.hex, true),
	};
}

let activePalette = pickSplashPalette();
let activeStyles = compileSplashPalette(activePalette);

function selectSplashPalette(): void {
	activePalette = pickSplashPalette();
	activeStyles = compileSplashPalette(activePalette);
}

/** Names of the curated splash palettes, in declaration order. */
export function getSplashPaletteNames(): string[] {
	return SPLASH_PALETTES.map((palette) => palette.name);
}

/** The persisted palette preference ("random" when none is pinned). */
export function getSplashPalettePreference(): string {
	return preferredPaletteName ?? SPLASH_PALETTE_RANDOM;
}

/**
 * Pin the splash palette by name, or restore random pick-per-splash with
 * "random"/undefined. Takes effect immediately on the active splash.
 */
export function setSplashPalette(name: string | undefined): void {
	preferredPaletteName = name === SPLASH_PALETTE_RANDOM ? undefined : name;
	selectSplashPalette();
}

/** Return the six styles used by the currently active splash palette. */
export function getActiveSplashBandStyles(): readonly SplashBandStyle[] {
	return activeStyles.bands;
}

// Prism crystal: two pyramids stitched at a shared square base (a bipyramid).
// Vertex 0 is the top apex, vertex 5 the bottom apex.
const CRYSTAL_VERTICES: Vec3[] = [
	{ x: 0, y: 1.3, z: 0 },
	{ x: 1, y: 0, z: 1 },
	{ x: -1, y: 0, z: 1 },
	{ x: -1, y: 0, z: -1 },
	{ x: 1, y: 0, z: -1 },
	{ x: 0, y: -1.3, z: 0 },
];

const CRYSTAL_FACES: Array<[number, number, number]> = [
	[0, 1, 2],
	[0, 2, 3],
	[0, 3, 4],
	[0, 4, 1],
	[5, 2, 1],
	[5, 3, 2],
	[5, 4, 3],
	[5, 1, 4],
];

const BOTTOM_APEX = 5;

// Luminance ramps (dark -> bright). The lower pyramid uses a distinct glyph
// family so the two halves of the crystal read differently.
const UPPER_BAND_GLYPHS = [".", ":", "=", "*", "#", "%"];
const LOWER_BAND_GLYPHS = ["'", "-", "~", "+", "x", "&"];

const LIGHT_DIRECTION = normalize({ x: -0.3, y: 0.7, z: 0.75 });

const BACKGROUND_CUBE_COUNT = 20;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
// Clearance around the crystal (x in [-1,1], y in [-1.3,1.3], and it tumbles
// freely in 3D so its screen footprint can swing wider) so background cubes
// never touch it. Fixed in local units, same as the crystal's own geometry -
// unlike the outer field edge below, this does not depend on terminal size.
const PYRAMID_CLEAR_X = 1.8;
const PYRAMID_CLEAR_Y = 2.0;

type BackgroundCubeSeed = { angle: number; t: number; radius: number; drift: number; speed: number; phase: number };

// Sunflower-seed spiral (evenly covers a disc, unlike naive random scatter
// which clumps for a count this low), storing only angle + radial fraction
// `t` (0 = hugging the pyramid clearance, 1 = the canvas edge). The actual
// (x, y) is resolved per-render against that frame's box size, so the field
// always reaches the full available width/height instead of a fixed disc.
function createBackgroundCubeSeeds(): BackgroundCubeSeed[] {
	return Array.from({ length: BACKGROUND_CUBE_COUNT }, (_, index) => {
		const direction = index % 2 === 0 ? 1 : -1;
		return {
			angle: index * GOLDEN_ANGLE,
			t: Math.sqrt((index + 0.5) / BACKGROUND_CUBE_COUNT),
			radius: 0.14 + Math.random() * 0.12,
			drift: 0.06 + Math.random() * 0.08,
			speed: direction * (0.3 + Math.random() * 0.35),
			phase: Math.random() * Math.PI * 2,
		};
	});
}

const BACKGROUND_CUBE_SEEDS = createBackgroundCubeSeeds();

function ellipseRadiusAt(angle: number, semiX: number, semiY: number): number {
	const cos = Math.cos(angle);
	const sin = Math.sin(angle);
	return 1 / Math.sqrt((cos / semiX) ** 2 + (sin / semiY) ** 2);
}

const CUBE_BAND_GLYPHS = ["·", ".", ":", "o", "O", "0"];

type Triangle = [number, number, number];

function createCubeMesh(): { vertices: Vec3[]; faces: Triangle[] } {
	// Corners normalized to unit circumradius so `radius` means the same
	// thing here as it did for the sphere mesh it replaced.
	const corner = 1 / Math.sqrt(3);
	const signs: Array<[number, number, number]> = [
		[-1, -1, -1],
		[1, -1, -1],
		[1, 1, -1],
		[-1, 1, -1],
		[-1, -1, 1],
		[1, -1, 1],
		[1, 1, 1],
		[-1, 1, 1],
	];
	const vertices: Vec3[] = signs.map(([x, y, z]) => ({ x: x * corner, y: y * corner, z: z * corner }));
	const faces: Triangle[] = [
		[0, 1, 2],
		[0, 2, 3], // front
		[5, 4, 7],
		[5, 7, 6], // back
		[4, 0, 3],
		[4, 3, 7], // left
		[1, 5, 6],
		[1, 6, 2], // right
		[3, 2, 6],
		[3, 6, 7], // top
		[4, 5, 1],
		[4, 1, 0], // bottom
	];
	return { vertices, faces };
}

const CUBE_MESH = createCubeMesh();

function randomTarget(from: number): number {
	let delta = Math.PI / 2 + (Math.random() * (Math.PI * 3)) / 2;
	if (Math.random() < 0.5) delta = -delta;
	return from + delta;
}

function springStep(axis: AxisSpring, deltaSeconds: number): void {
	// This is the critically simple spring update used by harmonica's NewSpring
	// seam: the real elapsed time is applied each frame, and the damping is
	// exponential so a delayed render cannot make the animation unstable.
	const stiffness = ROTATION_FREQUENCY * ROTATION_FREQUENCY;
	axis.velocity += (axis.target - axis.angle) * stiffness * deltaSeconds;
	axis.velocity *= Math.exp(-ROTATION_DAMPING * ROTATION_FREQUENCY * deltaSeconds);
	axis.angle += axis.velocity * deltaSeconds;
	if (Math.abs(axis.angle - axis.target) < SETTLE_POSITION && Math.abs(axis.velocity) < SETTLE_VELOCITY) {
		axis.target = randomTarget(axis.angle);
	}
}

export class SplashAnimator {
	private axes: [AxisSpring, AxisSpring, AxisSpring] = [
		{ angle: 0, velocity: 0, target: randomTarget(0) },
		{ angle: 0, velocity: 0, target: randomTarget(0) },
		{ angle: 0, velocity: 0, target: randomTarget(0) },
	];
	private lastTime: number | undefined;

	advance(now: number): readonly [number, number, number] {
		if (this.lastTime === undefined) {
			this.lastTime = now;
			return [0, 0, 0];
		}

		let deltaSeconds = (now - this.lastTime) / 1000;
		this.lastTime = now;
		if (deltaSeconds <= 0) {
			return [this.axes[0].angle, this.axes[1].angle, this.axes[2].angle];
		}
		deltaSeconds = Math.min(deltaSeconds, MAX_DELTA_SECONDS);
		for (const axis of this.axes) springStep(axis, deltaSeconds);
		return [this.axes[0].angle, this.axes[1].angle, this.axes[2].angle];
	}
}

let defaultAnimator = new SplashAnimator();
let splashStartTime: number | undefined;

export function resetSplashAnimation(): void {
	defaultAnimator = new SplashAnimator();
	splashStartTime = undefined;
}

export function fits(width: number, height: number): boolean {
	return width >= MIN_WIDTH && height >= MIN_HEIGHT;
}

function styleForHex(hex: string, bold = false): SplashBandStyle {
	const r = Number.parseInt(hex.slice(1, 3), 16);
	const g = Number.parseInt(hex.slice(3, 5), 16);
	const b = Number.parseInt(hex.slice(5, 7), 16);
	const open = `${bold ? "\x1b[1m" : ""}\x1b[38;2;${r};${g};${b}m`;
	const close = `\x1b[39m${bold ? "\x1b[22m" : ""}`;
	return (text: string) => `${open}${text}${close}`;
}

function wordmarkStyle(text: string): string {
	try {
		return theme.bold(theme.fg("accent", text));
	} catch {
		return text;
	}
}

function sub(a: Vec3, b: Vec3): Vec3 {
	return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function dot(a: Vec3, b: Vec3): number {
	return a.x * b.x + a.y * b.y + a.z * b.z;
}

function cross(a: Vec3, b: Vec3): Vec3 {
	return {
		x: a.y * b.z - a.z * b.y,
		y: a.z * b.x - a.x * b.z,
		z: a.x * b.y - a.y * b.x,
	};
}

function normalize(value: Vec3): Vec3 {
	const length = Math.sqrt(dot(value, value));
	return length === 0 ? value : { x: value.x / length, y: value.y / length, z: value.z / length };
}

function rotateX(value: Vec3, angle: number): Vec3 {
	const sine = Math.sin(angle);
	const cosine = Math.cos(angle);
	return { x: value.x, y: value.y * cosine - value.z * sine, z: value.y * sine + value.z * cosine };
}

function rotateY(value: Vec3, angle: number): Vec3 {
	const sine = Math.sin(angle);
	const cosine = Math.cos(angle);
	return { x: value.x * cosine + value.z * sine, y: value.y, z: -value.x * sine + value.z * cosine };
}

function rotateZ(value: Vec3, angle: number): Vec3 {
	const sine = Math.sin(angle);
	const cosine = Math.cos(angle);
	return { x: value.x * cosine - value.y * sine, y: value.x * sine + value.y * cosine, z: value.z };
}

function project(value: Vec3, centerX: number, centerY: number, scale: number): Point {
	return { x: centerX + value.x * scale * 2, y: centerY - value.y * scale };
}

function clamp(value: number, minimum: number, maximum: number): number {
	return Math.max(minimum, Math.min(maximum, value));
}

function edge(a: Point, b: Point, c: Point): number {
	return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function shade(a: Vec3, b: Vec3, c: Vec3, origin: Vec3 = { x: 0, y: 0, z: 0 }): number {
	let normal = normalize(cross(sub(b, a), sub(c, a)));
	const centroid = {
		x: (a.x + b.x + c.x) / 3,
		y: (a.y + b.y + c.y) / 3,
		z: (a.z + b.z + c.z) / 3,
	};
	if (dot(normal, sub(centroid, origin)) < 0) normal = { x: -normal.x, y: -normal.y, z: -normal.z };
	const luminance = dot(normal, LIGHT_DIRECTION);
	if (luminance < -0.1) return 0;
	if (luminance < 0.15) return 1;
	if (luminance < 0.4) return 2;
	if (luminance < 0.65) return 3;
	if (luminance < 0.85) return 4;
	return 5;
}

function drawFacetedCube(
	center: Vec3,
	radius: number,
	angles: readonly [number, number, number],
	centerX: number,
	centerY: number,
	scale: number,
	width: number,
	height: number,
	glyphs: string[],
	styles: number[],
	depth: number[],
): void {
	const vertices = CUBE_MESH.vertices.map((vertex) => {
		const rotated = rotateZ(rotateY(rotateX(vertex, angles[0]), angles[1]), angles[2]);
		return {
			x: center.x + rotated.x * radius,
			y: center.y + rotated.y * radius,
			z: center.z + rotated.z * radius,
		};
	});

	for (const face of CUBE_MESH.faces) {
		const a = vertices[face[0]]!;
		const b = vertices[face[1]]!;
		const c = vertices[face[2]]!;
		rasterize(
			project(a, centerX, centerY, scale),
			project(b, centerX, centerY, scale),
			project(c, centerX, centerY, scale),
			a.z - BACKGROUND_DEPTH_BIAS,
			b.z - BACKGROUND_DEPTH_BIAS,
			c.z - BACKGROUND_DEPTH_BIAS,
			shade(a, b, c, center),
			width,
			height,
			CUBE_BAND_GLYPHS,
			glyphs,
			styles,
			depth,
		);
	}
}

function rasterize(
	p0: Point,
	p1: Point,
	p2: Point,
	z0: number,
	z1: number,
	z2: number,
	shadeIndex: number,
	width: number,
	height: number,
	bandGlyphs: string[],
	glyphs: string[],
	styles: number[],
	depth: number[],
): void {
	const area = edge(p0, p1, p2);
	if (area === 0) return;
	const minX = clamp(Math.floor(Math.min(p0.x, p1.x, p2.x)), 0, width - 1);
	const maxX = clamp(Math.ceil(Math.max(p0.x, p1.x, p2.x)), 0, width - 1);
	const minY = clamp(Math.floor(Math.min(p0.y, p1.y, p2.y)), 0, height - 1);
	const maxY = clamp(Math.ceil(Math.max(p0.y, p1.y, p2.y)), 0, height - 1);
	for (let y = minY; y <= maxY; y++) {
		for (let x = minX; x <= maxX; x++) {
			const point = { x, y };
			const weight0 = edge(p1, p2, point) / area;
			const weight1 = edge(p2, p0, point) / area;
			const weight2 = edge(p0, p1, point) / area;
			if (weight0 < 0 || weight1 < 0 || weight2 < 0) continue;
			const cell = y * width + x;
			const cellDepth = weight0 * z0 + weight1 * z1 + weight2 * z2;
			if (cellDepth <= depth[cell]) continue;
			depth[cell] = cellDepth;
			styles[cell] = shadeIndex;
			glyphs[cell] = bandGlyphs[shadeIndex];
		}
	}
}

function styleLine(glyphs: string[], styles: number[], palette: SplashBandStyle[]): string {
	let output = "";
	let start = 0;
	while (start < glyphs.length) {
		const isSky = glyphs[start] === " ";
		let end = start + 1;
		while (end < glyphs.length && (glyphs[end] === " ") === isSky && styles[end] === styles[start]) end++;
		const segment = glyphs.slice(start, end).join("");
		output += isSky ? segment : palette[styles[start]](segment);
		start = end;
	}
	return output;
}

function renderAnimatedWordmark(width: number, now: number, startTime?: number): string {
	if (startTime === undefined) {
		if (splashStartTime === undefined) splashStartTime = now;
		startTime = splashStartTime;
	}
	const elapsed = Math.max(0, now - startTime);
	const progress = clamp(elapsed / WORDMARK_TRAVEL_MS, 0, 1);
	const eased = 1 - (1 - progress) ** 3;
	const text = APP_NAME.toUpperCase().split("").join(" ");
	const midpoint = Math.ceil(text.length / 2);
	const left = text.slice(0, midpoint);
	const right = text.slice(midpoint);
	const targetLeft = Math.floor((width - text.length) / 2);
	const targetRight = targetLeft + midpoint;
	const cells = Array<string>(width).fill(" ");
	const styles: Array<SplashBandStyle | undefined> = Array<SplashBandStyle | undefined>(width).fill(undefined);

	const place = (part: string, start: number, style: SplashBandStyle): void => {
		for (let index = 0; index < part.length; index++) {
			const position = start + index;
			if (position < 0 || position >= width) continue;
			cells[position] = part[index]!;
			styles[position] = style;
		}
	};

	const leftStart = Math.round(targetLeft - (1 - eased) * (targetLeft + left.length));
	const rightStart = Math.round(targetRight + (1 - eased) * (width - targetRight));
	place(left, leftStart, activeStyles.header);
	place(right, rightStart, activeStyles.header);

	const sweepDuration = 720;
	const sweepElapsed = elapsed - WORDMARK_ENTRANCE_MS;
	if (sweepElapsed >= 0 && sweepElapsed <= sweepDuration) {
		const sweepCenter = (sweepElapsed / sweepDuration) * (text.length + 4) - 2;
		for (let index = 0; index < text.length; index++) {
			const position = targetLeft + index;
			if (Math.abs(index - sweepCenter) <= 1 && position >= 0 && position < width && cells[position] !== " ") {
				styles[position] = activeStyles.bands[5];
			}
		}
	}

	let output = "";
	for (let index = 0; index < width; index++) {
		const style = styles[index];
		output += style === undefined ? cells[index] : style(cells[index]!);
	}
	return output;
}

export function renderSplash(
	width: number,
	height: number,
	now: number,
	animator: SplashAnimator = defaultAnimator,
	wordmarkStartTime?: number,
): string {
	if (!fits(width, height)) return "";
	const boxWidth = Math.min(width, MAX_WIDTH);
	const boxHeight = Math.min(height, MAX_HEIGHT);
	const [angleX, angleY, angleZ] = animator.advance(now);
	const centerX = (boxWidth - 1) / 2;
	const centerY = (boxHeight - 1) / 2;
	const scale = Math.min(boxWidth / 2 / (VIEW_RADIUS * 2), boxHeight / 2 / VIEW_RADIUS) * SCALE;
	const vertices = CRYSTAL_VERTICES.map((vertex) =>
		rotateX(rotateZ(rotateY(rotateX(vertex, angleX), angleY), angleZ), MODEL_TILT),
	);
	const glyphs = Array<string>(boxWidth * boxHeight).fill(" ");
	const styles = Array<number>(boxWidth * boxHeight).fill(0);
	const depth = Array<number>(boxWidth * boxHeight).fill(Number.NEGATIVE_INFINITY);
	const { bands: palette } = activeStyles;

	// Local x reaches twice as far per pixel as y (see project()), so these
	// are the local-unit distances that land exactly on the box's edges for
	// *this* render's actual size.
	const cubeFieldEdgeX = boxWidth / 2 / (scale * 2);
	const cubeFieldEdgeY = boxHeight / 2 / scale;

	const seconds = now / 1000;
	for (const seed of BACKGROUND_CUBE_SEEDS) {
		const innerR = ellipseRadiusAt(seed.angle, PYRAMID_CLEAR_X, PYRAMID_CLEAR_Y);
		const outerR = ellipseRadiusAt(seed.angle, cubeFieldEdgeX, cubeFieldEdgeY);
		const anchorR = innerR + seed.t * (outerR - innerR);
		const anchorX = Math.cos(seed.angle) * anchorR;
		const anchorY = Math.sin(seed.angle) * anchorR;
		const theta = seed.phase + seconds * seed.speed;
		const angles: [number, number, number] = [
			seconds * seed.speed * 1.17 + seed.phase,
			seconds * seed.speed * 0.83 - seed.phase,
			seconds * seed.speed * 0.61 + seed.phase * 0.5,
		];
		drawFacetedCube(
			{
				x: anchorX + seed.drift * Math.cos(theta),
				y: anchorY + seed.drift * Math.sin(theta),
				z: 0,
			},
			seed.radius,
			angles,
			centerX,
			centerY,
			scale,
			boxWidth,
			boxHeight,
			glyphs,
			styles,
			depth,
		);
	}

	for (const face of CRYSTAL_FACES) {
		const bandGlyphs = face.includes(BOTTOM_APEX) ? LOWER_BAND_GLYPHS : UPPER_BAND_GLYPHS;
		const a = vertices[face[0]];
		const b = vertices[face[1]];
		const c = vertices[face[2]];
		const shadeIndex = shade(a, b, c);
		rasterize(
			project(a, centerX, centerY, scale),
			project(b, centerX, centerY, scale),
			project(c, centerX, centerY, scale),
			a.z,
			b.z,
			c.z,
			shadeIndex,
			boxWidth,
			boxHeight,
			bandGlyphs,
			glyphs,
			styles,
			depth,
		);
	}

	const lines: string[] = [];
	for (let row = 0; row < boxHeight; row++) {
		const start = row * boxWidth;
		lines.push(styleLine(glyphs.slice(start, start + boxWidth), styles.slice(start, start + boxWidth), palette));
	}

	// Wordmark halves enter laterally from opposite sides, then receive a
	// deterministic horizontal highlight sweep before settling.
	const headerText = APP_NAME.toUpperCase().split("").join(" ");
	if (headerText.length <= boxWidth) lines[1] = renderAnimatedWordmark(boxWidth, now, wordmarkStartTime);

	return lines.join("\n");
}

export function renderStaticWordmark(wordmark: string = APP_NAME): string {
	return wordmarkStyle(wordmark);
}

type SplashUi = Pick<TUI, "terminal" | "requestRender">;

export class SplashComponent implements Component {
	private timer: ReturnType<typeof setInterval> | undefined;
	private readonly wordmarkStartTime = Date.now();

	constructor(
		private readonly ui: SplashUi,
		private readonly fallbackWordmark: string = APP_NAME,
	) {
		selectSplashPalette();
		this.start();
	}

	get isRunning(): boolean {
		return this.timer !== undefined;
	}

	start(): void {
		if (this.timer !== undefined) return;
		this.timer = setInterval(() => this.ui.requestRender(), FRAME_INTERVAL_MS);
	}

	stop(): void {
		if (this.timer === undefined) return;
		clearInterval(this.timer);
		this.timer = undefined;
	}

	dispose(): void {
		this.stop();
	}

	invalidate(): void {
		// Frames are derived from wall-clock time and are not cached.
	}

	render(width: number): string[] {
		const art = renderSplash(width, this.ui.terminal.rows, Date.now(), defaultAnimator, this.wordmarkStartTime);
		if (art) {
			const leftMargin = Math.floor((width - Math.min(width, MAX_WIDTH)) / 2);
			const availableWidth = width - leftMargin;
			return art.split("\n").map((line) => `${" ".repeat(leftMargin)}${truncateToWidth(line, availableWidth, "")}`);
		}

		const wordmark = truncateToWidth(renderStaticWordmark(this.fallbackWordmark), Math.max(0, width), "");
		const leftMargin = Math.max(0, Math.floor((width - visibleWidth(wordmark)) / 2));
		return [`${" ".repeat(leftMargin)}${wordmark}`];
	}
}
