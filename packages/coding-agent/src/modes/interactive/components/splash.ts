import { type Component, type TUI, truncateToWidth, visibleWidth } from "@void/tui";
import { APP_NAME } from "../../../config.js";
import { theme } from "../theme/theme.js";

export const FRAME_INTERVAL_MS = 90;
export const MIN_WIDTH = 30;
export const MIN_HEIGHT = 11;
export const MAX_WIDTH = 60;
export const MAX_HEIGHT = 22;

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
type Style = (text: string) => string;

type SplashPalette = {
	bands: Array<{ hex: string; bold?: boolean }>;
	spheres: [string, string, string];
};

type CompiledSplashPalette = {
	bands: Style[];
	spheres: Style[];
	combined: Style[];
	header: Style;
};

// Curated splash palettes. Each is a coherent dark -> bright shading ramp:
// bands map to the pyramid's six luminance levels, spheres to the background
// orbiters. One palette is picked at random per splash (new/clear).
// The amber ramp is the original Go void splash palette.
const SPLASH_PALETTES: SplashPalette[] = [
	{
		// amber: ember -> rust -> soft red -> amber -> yellow -> pale highlight
		bands: [
			{ hex: "#6B4632" },
			{ hex: "#A05A46" },
			{ hex: "#C96A55" },
			{ hex: "#FFB454" },
			{ hex: "#E8C56E", bold: true },
			{ hex: "#F5DFA0", bold: true },
		],
		spheres: ["#6B4632", "#8A5A46", "#A66A50"],
	},
	{
		// green: moss -> leaf -> spring -> mint highlight
		bands: [
			{ hex: "#33502F" },
			{ hex: "#4A7040" },
			{ hex: "#5E9450" },
			{ hex: "#7FCB6E" },
			{ hex: "#A8E08A", bold: true },
			{ hex: "#D9F5BE", bold: true },
		],
		spheres: ["#33502F", "#46663C", "#587F49"],
	},
	{
		// blue: midnight -> steel -> sky -> ice highlight
		bands: [
			{ hex: "#2E3F5C" },
			{ hex: "#3D5A80" },
			{ hex: "#4F7CAC" },
			{ hex: "#64A6E8" },
			{ hex: "#98C9F0", bold: true },
			{ hex: "#CFE7FA", bold: true },
		],
		spheres: ["#2E3F5C", "#3A5273", "#48688F"],
	},
	{
		// red: maroon -> brick -> coral -> blush highlight
		bands: [
			{ hex: "#5C2A2A" },
			{ hex: "#8A3A3A" },
			{ hex: "#B54848" },
			{ hex: "#E85E55" },
			{ hex: "#F09080", bold: true },
			{ hex: "#F8C8B8", bold: true },
		],
		spheres: ["#5C2A2A", "#763434", "#914040"],
	},
	{
		// violet: plum -> orchid -> lavender highlight
		bands: [
			{ hex: "#443055" },
			{ hex: "#5F4478" },
			{ hex: "#7C58A0" },
			{ hex: "#A97FE0" },
			{ hex: "#C7A6F0", bold: true },
			{ hex: "#E6D6FA", bold: true },
		],
		spheres: ["#443055", "#553D6A", "#684C82"],
	},
];

function pickSplashPalette(): SplashPalette {
	return SPLASH_PALETTES[Math.floor(Math.random() * SPLASH_PALETTES.length)] as SplashPalette;
}

function compileSplashPalette(palette: SplashPalette): CompiledSplashPalette {
	const bands = palette.bands.map((band) => styleForHex(band.hex, band.bold));
	const spheres = palette.spheres.map((hex) => styleForHex(hex));
	return {
		bands,
		spheres,
		combined: [...bands, ...spheres],
		header: styleForHex(palette.bands[3]!.hex, true),
	};
}

let activePalette = pickSplashPalette();
let activeStyles = compileSplashPalette(activePalette);

function selectSplashPalette(): void {
	activePalette = pickSplashPalette();
	activeStyles = compileSplashPalette(activePalette);
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

const BACKGROUND_SPHERES = [
	{ x: -2.9, y: 1.55, radius: 0.62, drift: 0.25, speed: 0.22, phase: 0.7 },
	{ x: 3, y: -1.45, radius: 0.45, drift: 0.35, speed: -0.16, phase: 2.6 },
	{ x: 2.7, y: 1.65, radius: 0.3, drift: 0.3, speed: 0.3, phase: 4.4 },
];

const SPHERE_GLYPHS = ["·", "o", "O"];

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

export function resetSplashAnimation(): void {
	defaultAnimator = new SplashAnimator();
}

export function fits(width: number, height: number): boolean {
	return width >= MIN_WIDTH && height >= MIN_HEIGHT;
}

function styleForHex(hex: string, bold = false): Style {
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

function shade(a: Vec3, b: Vec3, c: Vec3): number {
	let normal = normalize(cross(sub(b, a), sub(c, a)));
	const centroid = {
		x: (a.x + b.x + c.x) / 3,
		y: (a.y + b.y + c.y) / 3,
		z: (a.z + b.z + c.z) / 3,
	};
	if (dot(normal, centroid) < 0) normal = { x: -normal.x, y: -normal.y, z: -normal.z };
	const luminance = dot(normal, LIGHT_DIRECTION);
	if (luminance < -0.1) return 0;
	if (luminance < 0.15) return 1;
	if (luminance < 0.4) return 2;
	if (luminance < 0.65) return 3;
	if (luminance < 0.85) return 4;
	return 5;
}

function drawSphere(
	center: Vec3,
	radius: number,
	centerX: number,
	centerY: number,
	scale: number,
	width: number,
	height: number,
	styleBase: number,
	glyphs: string[],
	styles: number[],
	depth: number[],
): void {
	const projected = project(center, centerX, centerY, scale);
	let radiusX = radius * scale * 2;
	let radiusY = radius * scale;
	if (radiusY < 1) {
		radiusX = 2;
		radiusY = 1;
	}
	const minX = clamp(Math.floor(projected.x - radiusX), 0, width - 1);
	const maxX = clamp(Math.ceil(projected.x + radiusX), 0, width - 1);
	const minY = clamp(Math.floor(projected.y - radiusY), 0, height - 1);
	const maxY = clamp(Math.ceil(projected.y + radiusY), 0, height - 1);
	for (let y = minY; y <= maxY; y++) {
		for (let x = minX; x <= maxX; x++) {
			const u = (x - projected.x) / radiusX;
			const v = (y - projected.y) / radiusY;
			const distanceSquared = u * u + v * v;
			if (distanceSquared > 1) continue;
			const normalZ = Math.sqrt(1 - distanceSquared);
			const cell = y * width + x;
			const cellDepth = center.z + normalZ * radius - BACKGROUND_DEPTH_BIAS;
			if (cellDepth <= depth[cell]) continue;
			depth[cell] = cellDepth;
			const luminance = dot({ x: u, y: -v, z: normalZ }, LIGHT_DIRECTION);
			const shadeIndex = luminance > 0.65 ? 2 : luminance > 0.25 ? 1 : 0;
			glyphs[cell] = SPHERE_GLYPHS[shadeIndex];
			styles[cell] = styleBase + shadeIndex;
		}
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

function styleLine(glyphs: string[], styles: number[], palette: Style[]): string {
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

export function renderSplash(
	width: number,
	height: number,
	now: number,
	animator: SplashAnimator = defaultAnimator,
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
	const { bands: palette, combined: combinedPalette } = activeStyles;

	const seconds = now / 1000;
	for (const sphere of BACKGROUND_SPHERES) {
		const theta = sphere.phase + seconds * sphere.speed;
		drawSphere(
			{
				x: sphere.x + sphere.drift * Math.cos(theta),
				y: sphere.y + sphere.drift * Math.sin(theta),
				z: 0,
			},
			sphere.radius,
			centerX,
			centerY,
			scale,
			boxWidth,
			boxHeight,
			palette.length,
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
		lines.push(
			styleLine(glyphs.slice(start, start + boxWidth), styles.slice(start, start + boxWidth), combinedPalette),
		);
	}

	// Wordmark header, centered above the pyramid in the palette's signature color
	const headerText = APP_NAME.toUpperCase().split("").join(" ");
	if (headerText.length <= boxWidth) {
		const pad = Math.floor((boxWidth - headerText.length) / 2);
		lines[1] = " ".repeat(pad) + activeStyles.header(headerText);
	}

	return lines.join("\n");
}

export function renderStaticWordmark(wordmark: string = APP_NAME): string {
	return wordmarkStyle(wordmark);
}

type SplashUi = Pick<TUI, "terminal" | "requestRender">;

export class SplashComponent implements Component {
	private timer: ReturnType<typeof setInterval> | undefined;

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
		const art = renderSplash(width, this.ui.terminal.rows, Date.now());
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
