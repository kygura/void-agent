// A five-row block font. Each glyph is five rows of '#' and spaces.
const GLYPHS: Record<string, string[]> = {
  A: [' ### ', '#   #', '#####', '#   #', '#   #'],
  B: ['#### ', '#   #', '#### ', '#   #', '#### '],
  C: [' ####', '#    ', '#    ', '#    ', ' ####'],
  D: ['#### ', '#   #', '#   #', '#   #', '#### '],
  E: ['#####', '#    ', '#### ', '#    ', '#####'],
  F: ['#####', '#    ', '#### ', '#    ', '#    '],
  G: [' ####', '#    ', '#  ##', '#   #', ' ### '],
  H: ['#   #', '#   #', '#####', '#   #', '#   #'],
  I: ['###', ' # ', ' # ', ' # ', '###'],
  J: ['  ###', '   # ', '   # ', '#  # ', ' ##  '],
  K: ['#   #', '#  # ', '###  ', '#  # ', '#   #'],
  L: ['#    ', '#    ', '#    ', '#    ', '#####'],
  M: ['#   #', '## ##', '# # #', '#   #', '#   #'],
  N: ['#   #', '##  #', '# # #', '#  ##', '#   #'],
  O: [' ### ', '#   #', '#   #', '#   #', ' ### '],
  P: ['#### ', '#   #', '#### ', '#    ', '#    '],
  Q: [' ### ', '#   #', '# # #', '#  # ', ' ## #'],
  R: ['#### ', '#   #', '#### ', '#  # ', '#   #'],
  S: [' ####', '#    ', ' ### ', '    #', '#### '],
  T: ['#####', '  #  ', '  #  ', '  #  ', '  #  '],
  U: ['#   #', '#   #', '#   #', '#   #', ' ### '],
  V: ['#   #', '#   #', '#   #', ' # # ', '  #  '],
  W: ['#   #', '#   #', '# # #', '## ##', '#   #'],
  X: ['#   #', ' # # ', '  #  ', ' # # ', '#   #'],
  Y: ['#   #', ' # # ', '  #  ', '  #  ', '  #  '],
  Z: ['#####', '   # ', '  #  ', ' #   ', '#####'],
  '0': [' ### ', '#  ##', '# # #', '##  #', ' ### '],
  '1': [' # ', '## ', ' # ', ' # ', '###'],
  '2': ['#### ', '    #', ' ### ', '#    ', '#####'],
  '3': ['#### ', '    #', ' ### ', '    #', '#### '],
  '4': ['#   #', '#   #', '#####', '    #', '    #'],
  '5': ['#####', '#    ', '#### ', '    #', '#### '],
  '6': [' ### ', '#    ', '#### ', '#   #', ' ### '],
  '7': ['#####', '    #', '   # ', '  #  ', '  #  '],
  '8': [' ### ', '#   #', ' ### ', '#   #', ' ### '],
  '9': [' ### ', '#   #', ' ####', '    #', ' ### '],
  ' ': ['   ', '   ', '   ', '   ', '   '],
  '.': [' ', ' ', ' ', ' ', '#'],
  ',': ['  ', '  ', '  ', ' #', '# '],
  '!': ['#', '#', '#', ' ', '#'],
  '?': ['### ', '   #', ' ## ', '    ', ' #  '],
  '-': ['    ', '    ', '####', '    ', '    '],
  '_': ['     ', '     ', '     ', '     ', '#####'],
  ':': [' ', '#', ' ', '#', ' '],
  '/': ['    #', '   # ', '  #  ', ' #   ', '#    '],
  "'": ['#', '#', ' ', ' ', ' '],
  '+': ['     ', '  #  ', '#####', '  #  ', '     '],
  '=': ['    ', '####', '    ', '####', '    '],
  '>': ['#   ', ' #  ', '  # ', ' #  ', '#   '],
  '<': ['   #', '  # ', ' #  ', '  # ', '   #'],
}

export type BannerStyle = 'block' | 'shade' | 'hash' | 'outline'

const INK: Record<Exclude<BannerStyle, 'outline'>, string> = { block: '█', shade: '▓', hash: '#' }

function glyphOf(char: string): string[] {
  return GLYPHS[char] ?? GLYPHS['?'] ?? []
}

function wordWidth(word: string): number {
  return [...word].reduce((sum, char) => sum + (glyphOf(char)[0] ?? '').length + 1, 0)
}

export function banner(text: string, style: BannerStyle = 'block', maxColumns = 200): string {
  const rows = ['', '', '', '', '']
  const lines: string[] = []
  const space = wordWidth(' ')
  const flush = (): void => {
    if (rows[0] !== '') lines.push(...rows.map(row => row.replace(/\s+$/, '')), '')
    rows.fill('')
  }
  const put = (char: string): void => {
    const glyph = glyphOf(char)
    for (let row = 0; row < 5; row += 1) rows[row] = `${rows[row] ?? ''}${glyph[row] ?? ''} `
  }
  for (const word of text.toUpperCase().split(/\s+/).filter(Boolean)) {
    const used = (rows[0] ?? '').length
    if (used > 0 && used + space + wordWidth(word) > maxColumns) flush()
    if ((rows[0] ?? '').length > 0) put(' ')
    for (const char of word) {
      if ((rows[0] ?? '').length + wordWidth(char) > maxColumns) flush()
      put(char)
    }
  }
  flush()
  const art = lines.join('\n').replace(/\n+$/, '')
  return style === 'outline' ? outline(art) : art.replace(/#/g, INK[style])
}

// Draws only the edges of the filled cells, in box-drawing characters.
function outline(art: string): string {
  const grid = art.split('\n').map(line => [...line])
  const filled = (y: number, x: number): boolean => grid[y]?.[x] === '#'
  return grid
    .map((line, y) =>
      line
        .map((cell, x) => {
          if (cell !== '#') return ' '
          const up = filled(y - 1, x)
          const down = filled(y + 1, x)
          const left = filled(y, x - 1)
          const right = filled(y, x + 1)
          if (up && down && left && right) return ' '
          if ((up || down) && !left && !right) return '│'
          if ((left || right) && !up && !down) return '─'
          return '┼'
        })
        .join('')
        .replace(/\s+$/, ''),
    )
    .join('\n')
}
