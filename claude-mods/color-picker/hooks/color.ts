export type Rgb = { r: number; g: number; b: number }
export type Hsl = { h: number; s: number; l: number }

const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value))

// Named colors worth typing: CSS basics plus the void TUI theme tokens.
export const NAMED: Record<string, string> = {
  black: '#000000',
  white: '#ffffff',
  red: '#ff0000',
  green: '#008000',
  blue: '#0000ff',
  orange: '#ffa500',
  purple: '#800080',
  teal: '#008080',
  'void-accent': '#8abeb7',
  'void-label': '#9575cd',
  'void-border': '#81a2be',
  'void-success': '#b5bd68',
  'void-warning': '#f0c674',
  'void-error': '#cc6666',
}

export function toHex({ r, g, b }: Rgb): string {
  const part = (n: number): string => Math.round(clamp(n, 0, 255)).toString(16).padStart(2, '0')
  return `#${part(r)}${part(g)}${part(b)}`
}

export function hexToRgb(hex: string): Rgb {
  const value = Number.parseInt(hex.slice(1), 16)
  return { r: (value >> 16) & 255, g: (value >> 8) & 255, b: value & 255 }
}

export function rgbToHsl({ r, g, b }: Rgb): Hsl {
  const [rn, gn, bn] = [r / 255, g / 255, b / 255]
  const max = Math.max(rn, gn, bn)
  const min = Math.min(rn, gn, bn)
  const l = (max + min) / 2
  if (max === min) return { h: 0, s: 0, l: l * 100 }
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h: number
  if (max === rn) h = (gn - bn) / d + (gn < bn ? 6 : 0)
  else if (max === gn) h = (bn - rn) / d + 2
  else h = (rn - gn) / d + 4
  return { h: h * 60, s: s * 100, l: l * 100 }
}

export function hslToRgb({ h, s, l }: Hsl): Rgb {
  const hn = (((h % 360) + 360) % 360) / 360
  const sn = clamp(s, 0, 100) / 100
  const ln = clamp(l, 0, 100) / 100
  if (sn === 0) return { r: ln * 255, g: ln * 255, b: ln * 255 }
  const q = ln < 0.5 ? ln * (1 + sn) : ln + sn - ln * sn
  const p = 2 * ln - q
  const channel = (t: number): number => {
    const tn = t < 0 ? t + 1 : t > 1 ? t - 1 : t
    if (tn < 1 / 6) return p + (q - p) * 6 * tn
    if (tn < 1 / 2) return q
    if (tn < 2 / 3) return p + (q - p) * (2 / 3 - tn) * 6
    return p
  }
  return { r: channel(hn + 1 / 3) * 255, g: channel(hn) * 255, b: channel(hn - 1 / 3) * 255 }
}

export const hslToHex = (hsl: Hsl): string => toHex(hslToRgb(hsl))

export function parseColor(input: string): string | undefined {
  const text = input.trim().toLowerCase()
  const named = NAMED[text]
  if (named !== undefined) return named
  const short = /^#?([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(text)
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`
  const long = /^#?([0-9a-f]{6})([0-9a-f]{2})?$/.exec(text)
  if (long) return `#${long[1]}`
  const rgb = /^rgba?\(\s*(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})/.exec(text)
  if (rgb) return toHex({ r: Number(rgb[1]), g: Number(rgb[2]), b: Number(rgb[3]) })
  const hsl = /^hsla?\(\s*(-?[\d.]+)(?:deg)?[\s,]+([\d.]+)%[\s,]+([\d.]+)%/.exec(text)
  if (hsl) return hslToHex({ h: Number(hsl[1]), s: Number(hsl[2]), l: Number(hsl[3]) })
  return undefined
}

// Every distinct hex color written in a text, in order of first appearance.
export function findColors(text: string): string[] {
  const seen = new Set<string>()
  for (const match of text.matchAll(/#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g)) {
    const hex = parseColor(match[0])
    if (hex !== undefined) seen.add(hex)
  }
  return [...seen]
}

function linear(channel: number): number {
  const c = channel / 255
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

export function luminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex)
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b)
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}

export function grade(ratio: number): string {
  if (ratio >= 7) return 'AAA'
  if (ratio >= 4.5) return 'AA'
  if (ratio >= 3) return 'AA large'
  return 'fail'
}

export function toOklch(hex: string): { l: number; c: number; h: number } {
  const { r, g, b } = hexToRgb(hex)
  const [lr, lg, lb] = [linear(r), linear(g), linear(b)]
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb)
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb)
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb)
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  const chroma = Math.hypot(A, B)
  const hue = (Math.atan2(B, A) * 180) / Math.PI
  return { l: L, c: chroma, h: chroma < 0.0005 ? 0 : hue < 0 ? hue + 360 : hue }
}

export function formats(hex: string): { hex: string; rgb: string; hsl: string; oklch: string } {
  const rgb = hexToRgb(hex)
  const hsl = rgbToHsl(rgb)
  const ok = toOklch(hex)
  return {
    hex,
    rgb: `rgb(${rgb.r} ${rgb.g} ${rgb.b})`,
    hsl: `hsl(${Math.round(hsl.h)} ${Math.round(hsl.s)}% ${Math.round(hsl.l)}%)`,
    oklch: `oklch(${(ok.l * 100).toFixed(1)}% ${ok.c.toFixed(3)} ${ok.h.toFixed(1)})`,
  }
}

export function nudge(hex: string, change: Partial<Hsl>): string {
  const hsl = rgbToHsl(hexToRgb(hex))
  return hslToHex({
    h: hsl.h + (change.h ?? 0),
    s: clamp(hsl.s + (change.s ?? 0), 0, 100),
    l: clamp(hsl.l + (change.l ?? 0), 0, 100),
  })
}

export function ramp(hex: string, steps = 9): string[] {
  const hsl = rgbToHsl(hexToRgb(hex))
  return Array.from({ length: steps }, (_, index) => hslToHex({ ...hsl, l: 92 - (index * 84) / (steps - 1) }))
}

export function harmonies(hex: string): Array<{ name: string; colors: string[] }> {
  const rotate = (deg: number): string => nudge(hex, { h: deg })
  return [
    { name: 'complement', colors: [hex, rotate(180)] },
    { name: 'triad', colors: [hex, rotate(120), rotate(240)] },
    { name: 'analogous', colors: [rotate(-30), hex, rotate(30)] },
    { name: 'split', colors: [hex, rotate(150), rotate(210)] },
  ]
}

// Foreground that reads best on the color: black or white.
export function inkFor(hex: string): string {
  return contrast(hex, '#000000') >= contrast(hex, '#ffffff') ? '#000000' : '#ffffff'
}
