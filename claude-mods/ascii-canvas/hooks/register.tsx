import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { CanvasMode, Frame } from '../types'
import { banner } from './font'
import type { BannerStyle } from './font'
import { flow } from './flow'

const PANE = 'ascii-canvas'
const TOOL = 'mcp__ascii-canvas__draw'
const MAX_FRAMES = 20

const frames = atom({ plugin: 'ascii-canvas', key: 'frames' } as const, [])
const index = atom({ plugin: 'ascii-canvas', key: 'index' } as const, 0)
const mode = atom({ plugin: 'ascii-canvas', key: 'mode' } as const, 'canvas')

const BORDER_STYLES = ['single', 'double', 'round', 'bold', 'singleDouble', 'doubleSingle', 'classic', 'arrow', 'dashed', 'quote']
const THEME_KEYS = ['claude', 'text', 'subtle', 'inactive', 'suggestion', 'success', 'warning', 'error', 'merged', 'permission', 'planMode', 'autoAccept', 'ide', 'promptBorder', 'diffAdded', 'diffRemoved']

async function show($: EngineInterface, frame: Frame, view: CanvasMode = 'canvas'): Promise<void> {
  let count = 0
  await update($, frames, list => {
    const next = [...list, frame].slice(-MAX_FRAMES)
    count = next.length
    return next
  })
  await update($, index, () => count - 1)
  await update($, mode, () => view)
  await $.ui.open({ id: PANE, title: 'Canvas' })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'banner', description: 'Draw text in block letters on the canvas', argumentHint: '[--block|--shade|--hash|--outline] text' })
    await $.command.register({ name: 'flow', description: 'Draw a box-and-arrow chain on the canvas', argumentHint: 'A -> B | C -> D; X -> Y' })
    await $.command.register({ name: 'canvas', description: 'Open the ASCII canvas pane' })
    await $.command.register({ name: 'styles', description: 'Sample the borders, text styles and theme colors this surface draws' })
    await $.tool.register({
      name: 'draw',
      description:
        'Show an ASCII/Unicode sketch to the user in the canvas pane: a diagram, a UI mockup, a layout, a state machine, a table. Monospace, kept verbatim. Use it to visualize an idea or a style before building it; the user can copy it or send it back into the prompt.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'A few words naming the sketch' },
          art: { type: 'string', description: 'The sketch, lines separated by newlines' },
        },
        required: ['art'],
      },
    })
    return next(e)
  })

  on('command.run', { command: 'banner' }, async ($, e) => {
    const match = /^--(block|shade|hash|outline)\s+/.exec(e.args.trim())
    const style = (match?.[1] ?? 'block') as BannerStyle
    const text = (match ? e.args.trim().slice(match[0].length) : e.args).trim() || 'void'
    const art = banner(text, style, Math.max(40, e.presentation.columns - 10))
    await show($, { title: `banner: ${text}`, art, origin: 'banner' })
    return { text: 'Drawn on the canvas.' }
  }).catch(() => ({ text: 'ascii-canvas: the banner could not be drawn.' }))

  on('command.run', { command: 'flow' }, async ($, e) => {
    const art = flow(e.args)
    if (art === '') return { text: 'Usage: /flow A -> B | C -> D; X -> Y' }
    await show($, { title: `flow: ${e.args.slice(0, 40)}`, art, origin: 'flow' })
    return { text: 'Drawn on the canvas.' }
  }).catch(() => ({ text: 'ascii-canvas: the flow could not be drawn.' }))

  on('command.run', { command: 'canvas' }, async $ => {
    await update($, mode, () => 'canvas')
    await $.ui.open({ id: PANE, title: 'Canvas' })
    return { text: 'Canvas opened.' }
  }).catch(() => ({ text: 'ascii-canvas: the pane could not be opened.' }))

  on('command.run', { command: 'styles' }, async $ => {
    await update($, mode, () => 'styles')
    await $.ui.open({ id: PANE, title: 'Canvas' })
    return { text: 'Style sampler opened.' }
  }).catch(() => ({ text: 'ascii-canvas: the pane could not be opened.' }))

  on('tool.call', { tool: TOOL }, async ($, e) => {
    const input = e as unknown as { title?: string; art?: string }
    const art = (input.art ?? '').replace(/\r\n?/g, '\n').replace(/[^\S\n\t]+$/gm, '')
    if (art.trim() === '') return { result: 'Nothing to draw: art was empty.' }
    await show($, { title: input.title ?? 'sketch', art, origin: 'model' })
    const lines = art.split('\n')
    const widest = Math.max(...lines.map(line => [...line].length))
    return { result: `Shown to the user in the canvas pane (${lines.length} lines, ${widest} columns wide).` }
  }).catch(() => ({ result: 'ascii-canvas: the sketch could not be shown.' }))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Code } = $.ui.resolve(e)
    const view = await read($, mode)

    const tabs = (
      <Box flexDirection="row" gap={2}>
        <Button key="mode-canvas" plain hotkey="c" dimColor={view !== 'canvas'} label="canvas" onPress={() => update($, mode, () => 'canvas')} />
        <Button key="mode-styles" plain hotkey="s" dimColor={view !== 'styles'} label="styles" onPress={() => update($, mode, () => 'styles')} />
      </Box>
    )

    if (view === 'styles') {
      return (
        <Box flexDirection="column" gap={1}>
          {tabs}
          <Box flexDirection="row" flexWrap="wrap" gap={1}>
            {BORDER_STYLES.map(style => (
              <Box borderStyle={style} paddingX={1}>
                <Text>{style}</Text>
              </Box>
            ))}
          </Box>
          <Box flexDirection="row" gap={2} flexWrap="wrap">
            <Text bold>bold</Text>
            <Text italic>italic</Text>
            <Text underline>underline</Text>
            <Text strikethrough>strike</Text>
            <Text dimColor>dim</Text>
            <Text inverse>inverse</Text>
          </Box>
          <Box flexDirection="row" gap={1} flexWrap="wrap">
            {THEME_KEYS.map(key => (
              <Text color={key}>■ {key}</Text>
            ))}
          </Box>
          <Text dimColor>▁▂▃▄▅▆▇█ ░▒▓ ⠋⠙⠹⠸ ○◐● ✓✗⊘ ├─└ ┌┐└┘ ▰▱ ▶◀</Text>
        </Box>
      )
    }

    const list = await read($, frames)
    const at = Math.min(await read($, index), Math.max(0, list.length - 1))
    const frame = list[at]
    if (frame === undefined) {
      return (
        <Box flexDirection="column" gap={1}>
          {tabs}
          <Text dimColor>Empty. Ask for a sketch, or try /banner hello and /flow plan -&gt; build -&gt; ship.</Text>
        </Box>
      )
    }

    return (
      <Box flexDirection="column" gap={1}>
        {tabs}
        <Box flexDirection="row" gap={1}>
          <Text bold wrap="truncate-end">
            {frame.title}
          </Text>
          <Text dimColor>
            {at + 1}/{list.length} · {frame.origin}
          </Text>
        </Box>
        <Code source={frame.art} language="text" wrap="truncate-end" />
        <Box flexDirection="row" gap={1} flexWrap="wrap">
          <Button key="prev" hotkey="h" label="prev" onPress={() => update($, index, value => Math.max(0, value - 1))} />
          <Button key="next" hotkey="l" label="next" onPress={() => update($, index, value => Math.min(list.length - 1, value + 1))} />
          <Button key="copy" hotkey="y" label="copy" onPress={press => $.ui.copy({ text: frame.art, surface: press.surface })} />
          <Button
            key="insert"
            hotkey="i"
            variant="primary"
            label="to prompt"
            onPress={() => $.prompt.fill({ text: `\n\`\`\`text\n${frame.art}\n\`\`\`\n`, mode: 'insert' })}
          />
          <Button
            key="drop"
            hotkey="d"
            dimColor
            label="drop"
            onPress={async () => {
              await update($, frames, all => all.filter((_, position) => position !== at))
              await update($, index, value => Math.max(0, value - 1))
            }}
          />
        </Box>
      </Box>
    )
  })
}
