import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Swatch } from '../types'
import { contrast, findColors, formats, grade, harmonies, inkFor, nudge, parseColor, ramp } from './color'
import { stripCells, stripSvg } from './raster'

const PANE = 'color-picker'
const TOOL = 'mcp__color-picker__show_palette'

const current = atom({ plugin: 'color-picker', key: 'current' } as const, '#8abeb7')
const palette = atom({ plugin: 'color-picker', key: 'palette' } as const, [])
const paletteTitle = atom({ plugin: 'color-picker', key: 'paletteTitle' } as const, '')
const history = atom({ plugin: 'color-picker', key: 'history' } as const, [])

async function pick($: EngineInterface, hex: string): Promise<void> {
  await update($, current, () => hex)
  await update($, history, list => [hex, ...list.filter(one => one !== hex)].slice(0, 12))
}

async function conversationColors($: EngineInterface): Promise<Swatch[]> {
  const messages = await $.session.messages()
  const text = messages
    .slice(-30)
    .map(message => message.text)
    .join('\n')
  return findColors(text)
    .slice(0, 16)
    .map(hex => ({ hex }))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: 'show_palette',
      description:
        'Show a palette of colors to the user in the color pane, with WCAG contrast of each against black and white. Use when proposing or reviewing colors for a UI, theme or chart.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'What the palette is for' },
          colors: {
            type: 'array',
            items: {
              type: 'object',
              properties: { hex: { type: 'string' }, name: { type: 'string' } },
              required: ['hex'],
            },
          },
        },
        required: ['colors'],
      },
    })
    await $.command.register({
      name: 'swatch',
      description: 'Open the color pane on a color (#hex, rgb(), hsl(), a name), the selection, or colors from the conversation',
      argumentHint: '[color]',
    })
    return next(e)
  })

  on('command.run', { command: 'swatch' }, async ($, e) => {
    let hex = parseColor(e.args)
    let found: Swatch[] = []
    if (hex === undefined) {
      const selected = await $.ui.selection()
      hex = selected === undefined ? undefined : (parseColor(selected.text) ?? findColors(selected.text)[0])
    }
    if (hex === undefined) {
      found = await conversationColors($)
      hex = found[0]?.hex
    }
    if (hex !== undefined) await pick($, hex)
    if (found.length > 0) {
      await update($, palette, () => found)
      await update($, paletteTitle, () => 'from the conversation')
    }
    await $.ui.open({ id: PANE, title: 'Color' })
    const shown = await read($, current)
    return { text: `Color pane on ${shown}.` }
  }).catch(() => ({ text: 'color-picker: the pane could not be opened.' }))

  on('tool.call', { tool: TOOL }, async ($, e) => {
    const input = e as unknown as { title?: string; colors?: Array<{ hex?: string; name?: string }> }
    const swatches: Swatch[] = []
    const rejected: string[] = []
    for (const color of input.colors ?? []) {
      const hex = parseColor(color.hex ?? '')
      if (hex === undefined) rejected.push(String(color.hex))
      else swatches.push({ hex, name: color.name })
    }
    if (swatches.length === 0) return { result: `No readable colors in: ${rejected.join(', ')}` }

    await update($, palette, () => swatches)
    await update($, paletteTitle, () => input.title ?? 'proposed palette')
    const first = swatches[0]
    if (first !== undefined) await pick($, first.hex)
    await $.ui.open({ id: PANE, title: 'Color' })

    const lines = swatches.map(
      swatch =>
        `${swatch.name ?? swatch.hex} ${swatch.hex}: vs white ${contrast(swatch.hex, '#ffffff').toFixed(2)} (${grade(contrast(swatch.hex, '#ffffff'))}), vs black ${contrast(swatch.hex, '#000000').toFixed(2)} (${grade(contrast(swatch.hex, '#000000'))})`,
    )
    if (rejected.length > 0) lines.push(`Unreadable, skipped: ${rejected.join(', ')}`)
    return { result: `Shown to the user in the color pane.\n${lines.join('\n')}` }
  }).catch(() => ({ result: 'color-picker: the palette could not be shown.' }))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const hex = await read($, current)
    const swatches = await read($, palette)
    const title = await read($, paletteTitle)
    const recent = await read($, history)
    const values = formats(hex)
    const columns = Math.max(20, e.props.bodyColumns)
    const ink = inkFor(hex)

    const chip = (color: string, key: string, label?: string) => (
      <Box backgroundColor={color} paddingX={1}>
        <Button key={key} plain label={label ?? color} onPress={() => pick($, color)} />
      </Box>
    )

    const strip =
      e.surface === 'terminal' ? (
        (() => {
          const { Raster } = $.ui.resolve(e)
          return <Raster key="strip" columns={Math.min(columns, 72)} rows={1} cells={stripCells(hex, Math.min(columns, 72))} />
        })()
      ) : e.surface === 'desktop' || e.surface === 'vscode' || e.surface === 'mobile' ? (
        (() => {
          const { Svg } = $.ui.resolve(e)
          return <Svg source={stripSvg(hex)} alt={`hue and lightness strips around ${hex}`} />
        })()
      ) : null

    const onWhite = contrast(hex, '#ffffff')
    const onBlack = contrast(hex, '#000000')

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" gap={2}>
          <Box backgroundColor={hex} paddingX={3} paddingY={1}>
            <Text color={ink} bold>
              {hex}
            </Text>
          </Box>
          <Box flexDirection="column">
            {(['hex', 'rgb', 'hsl', 'oklch'] as const).map(format => (
              <Box flexDirection="row" gap={1}>
                <Button
                  key={`copy-${format}`}
                  plain
                  dimColor
                  label={format.padEnd(5)}
                  onPress={press => $.ui.copy({ text: values[format], surface: press.surface })}
                />
                <Text>{values[format]}</Text>
              </Box>
            ))}
          </Box>
        </Box>
        {strip}
        <Box flexDirection="row" gap={1} flexWrap="wrap">
          <Button key="hue-down" hotkey="q" label="hue -" onPress={() => pick($, nudge(hex, { h: -15 }))} />
          <Button key="hue-up" hotkey="w" label="hue +" onPress={() => pick($, nudge(hex, { h: 15 }))} />
          <Button key="sat-down" hotkey="a" label="sat -" onPress={() => pick($, nudge(hex, { s: -5 }))} />
          <Button key="sat-up" hotkey="s" label="sat +" onPress={() => pick($, nudge(hex, { s: 5 }))} />
          <Button key="light-down" hotkey="z" label="light -" onPress={() => pick($, nudge(hex, { l: -5 }))} />
          <Button key="light-up" hotkey="x" label="light +" onPress={() => pick($, nudge(hex, { l: 5 }))} />
          <Button key="insert" hotkey="i" variant="primary" label="insert" onPress={() => $.prompt.fill({ text: hex, mode: 'insert' })} />
        </Box>
        <Text>
          <Text dimColor>contrast </Text>
          <Text backgroundColor="#ffffff" color={hex}>
            {' on white '}
          </Text>
          <Text> {onWhite.toFixed(2)} {grade(onWhite)}  </Text>
          <Text backgroundColor="#000000" color={hex}>
            {' on black '}
          </Text>
          <Text> {onBlack.toFixed(2)} {grade(onBlack)}</Text>
        </Text>
        <Box flexDirection="column">
          <Text dimColor>ramp</Text>
          <Box flexDirection="row" flexWrap="wrap">
            {ramp(hex).map((color, index) => (
              <Box backgroundColor={color}>
                <Button key={`ramp-${index}`} plain label={` ${(index + 1) * 100} `} onPress={() => pick($, color)} />
              </Box>
            ))}
          </Box>
        </Box>
        <Box flexDirection="column">
          {harmonies(hex).map(harmony => (
            <Box flexDirection="row" gap={1}>
              <Text dimColor>{harmony.name.padEnd(10)}</Text>
              {harmony.colors.map((color, index) => chip(color, `${harmony.name}-${index}`))}
            </Box>
          ))}
        </Box>
        {swatches.length > 0 && (
          <Box flexDirection="column">
            <Text dimColor>{title}</Text>
            <Box flexDirection="row" gap={1} flexWrap="wrap">
              {swatches.map((swatch, index) => chip(swatch.hex, `palette-${index}`, swatch.name ? `${swatch.name} ${swatch.hex}` : swatch.hex))}
            </Box>
          </Box>
        )}
        {recent.length > 1 && (
          <Box flexDirection="row" gap={1} flexWrap="wrap">
            <Text dimColor>recent</Text>
            {recent.slice(1).map((color, index) => chip(color, `recent-${index}`))}
          </Box>
        )}
      </Box>
    )
  })
}
