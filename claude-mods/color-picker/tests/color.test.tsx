import { describe, expect, test } from 'claude-code/testing'

import { contrast, findColors, formats, nudge, parseColor } from '../hooks/color'

const PANE = {
  plugin: 'color-picker',
  component: 'Pane',
  requestId: 'color-picker',
  props: { title: 'Color', isFocused: true, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

describe('color math', () => {
  test('parses the usual spellings', () => {
    expect(parseColor('#abc')).toBe('#aabbcc')
    expect(parseColor('8ABEB7')).toBe('#8abeb7')
    expect(parseColor('rgb(255, 0, 0)')).toBe('#ff0000')
    expect(parseColor('hsl(120 100% 25%)')).toBe('#008000')
    expect(parseColor('void-accent')).toBe('#8abeb7')
    expect(parseColor('nope')).toBeUndefined()
  })

  test('converts and measures', () => {
    expect(formats('#ff0000').hsl).toBe('hsl(0 100% 50%)')
    expect(formats('#ffffff').oklch).toBe('oklch(100.0% 0.000 0.0)')
    expect(Math.round(contrast('#000000', '#ffffff'))).toBe(21)
    expect(nudge('#ff0000', { h: 120 })).toBe('#00ff00')
    expect(findColors('use #8abeb7 and #FFF, not #8abeb7 again')).toEqual(['#8abeb7', '#ffffff'])
  })
})

test('the palette tool fills the pane and the nudges move the color', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }))

  const shown = await $.tool.call({
    tool: 'mcp__color-picker__show_palette',
    title: 'void theme',
    colors: [{ hex: '#9575cd', name: 'label' }, { hex: '#b5bd68', name: 'success' }, { hex: 'bogus' }],
  })
  expect(String(shown.result)).toContain('Shown to the user')
  expect(String(shown.result)).toContain('bogus')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: '#9575cd' })).toBeDefined()
    expect(await ui.find({ type: 'Button', text: 'success #b5bd68' })).toBeDefined()
    expect(await ui.find({ type: surface === 'terminal' ? 'Raster' : 'Svg' })).toBeDefined()
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'light-up' })
  expect(await ui.find({ type: 'Text', text: '#9575cd' })).toBeUndefined()
  await ui.press({ key: 'palette-1' })
  expect(await ui.find({ type: 'Text', text: '#b5bd68' })).toBeDefined()
})
