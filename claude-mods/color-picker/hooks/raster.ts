import { hexToRgb, hslToHex, rgbToHsl } from './color'

const HALF_BLOCK = 0x2580 // upper half: foreground paints the top, background the bottom

function packed(hex: string): number {
  const { r, g, b } = hexToRgb(hex)
  return (r << 16) | (g << 8) | b
}

function toBase64(words: Uint32Array): string {
  const bytes = new Uint8Array(words.buffer)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

// Two strips in one row of half blocks: the hue wheel on top at the color's
// saturation and lightness, its lightness sweep beneath.
export function stripCells(hex: string, columns: number): string {
  const hsl = rgbToHsl(hexToRgb(hex))
  const words = new Uint32Array(columns * 3)
  for (let x = 0; x < columns; x += 1) {
    const t = columns === 1 ? 0 : x / (columns - 1)
    const top = hslToHex({ h: t * 360, s: Math.max(hsl.s, 40), l: Math.min(Math.max(hsl.l, 35), 65) })
    const bottom = hslToHex({ h: hsl.h, s: hsl.s, l: 95 - t * 90 })
    words[x * 3] = HALF_BLOCK
    words[x * 3 + 1] = packed(top)
    words[x * 3 + 2] = packed(bottom)
  }
  return toBase64(words)
}

export function stripSvg(hex: string): string {
  const hsl = rgbToHsl(hexToRgb(hex))
  const hues = Array.from({ length: 13 }, (_, i) => `<stop offset="${(i / 12).toFixed(3)}" stop-color="${hslToHex({ h: i * 30, s: Math.max(hsl.s, 40), l: Math.min(Math.max(hsl.l, 35), 65) })}"/>`).join('')
  const lights = Array.from({ length: 5 }, (_, i) => `<stop offset="${(i / 4).toFixed(2)}" stop-color="${hslToHex({ h: hsl.h, s: hsl.s, l: 95 - i * 22.5 })}"/>`).join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="360" height="24" viewBox="0 0 360 24"><defs><linearGradient id="h">${hues}</linearGradient><linearGradient id="l">${lights}</linearGradient></defs><rect width="360" height="12" fill="url(#h)"/><rect y="12" width="360" height="12" fill="url(#l)"/></svg>`
}
