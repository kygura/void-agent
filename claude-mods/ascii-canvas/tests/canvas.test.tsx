import { describe, expect, test } from 'claude-code/testing'

import { flow } from '../hooks/flow'
import { banner } from '../hooks/font'

const PANE = {
  plugin: 'ascii-canvas',
  component: 'Pane',
  requestId: 'ascii-canvas',
  props: { title: 'Canvas', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

describe('renderers', () => {
  test('banner draws five rows per line', () => {
    const art = banner('Hi', 'hash')
    expect(art.split('\n')).toEqual(['#   # ###', '#   #  #', '#####  #', '#   #  #', '#   # ###'])
    expect(banner('A', 'block')).toContain('█████')
    expect(banner('Hello world', 'block', 30).split('\n').length).toBe(11)
    expect(banner('Hello world', 'block', 30).split('\n')[6]?.startsWith('#') || banner('Hello world', 'block', 30).split('\n')[6]?.startsWith('█')).toBe(true)
  })

  test('flow joins boxes with arrows and stacks alternatives', () => {
    expect(flow('Plan -> Ship')).toBe(['┌──────┐    ┌──────┐', '│ Plan │───▶│ Ship │', '└──────┘    └──────┘'].join('\n'))
    const branched = flow('Run -> Pass | Fail; A -> B').split('\n')
    expect(branched[1]).toBe('│ Run │───▶│ Pass │')
    expect(branched[3]).toBe('           │ Fail │')
    expect(branched).toContain('│ A │───▶│ B │')
  })
})

test('the draw tool, the commands and the pane work together', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }))

  const drawn = await $.tool.call({ tool: 'mcp__ascii-canvas__draw', title: 'layout', art: '+--+\n|ok|\n+--+   ' })
  expect(String(drawn.result)).toContain('3 lines, 4 columns')
  await $.command.run({ command: 'flow', args: 'parse -> plan -> run', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Code' }))?.text).toContain('│ plan │')
    await ui.press({ key: 'prev' })
    expect((await ui.find({ type: 'Code' }))?.text).toBe('+--+\n|ok|\n+--+')
    await ui.press({ key: 'next' })
    await ui.press({ key: 'mode-styles' })
    expect(await ui.find({ type: 'Text', text: 'doubleSingle' })).toBeDefined()
    await ui.press({ key: 'mode-canvas' })
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'drop' })
  expect(await ui.find({ type: 'Text', text: '1/1 · model' })).toBeDefined()
})
