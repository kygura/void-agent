import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { LoopUsage } from '../types'

const MAIN = 'main'
const WARN_AT = 80
const DANGER_AT = 90

const loops = atom({ plugin: 'context-bar', key: 'loops' } as const, {})
const isHidden = atom({ plugin: 'context-bar', key: 'isHidden' } as const, false)
const isDetailed = atom({ plugin: 'context-bar', key: 'isDetailed' } as const, true)
const warnedAt = atom({ plugin: 'context-bar', key: 'warnedAt' } as const, 0)

type Loops = Record<string, LoopUsage>

/** One color per loop, by spawn order; main is always the accent. */
const PALETTE = ['suggestion', 'merged', 'planMode', 'autoAccept', 'ide', 'remember', 'permission'] as const
export const loopColor = (loop: LoopUsage) =>
  loop.id === MAIN ? 'claude' : (PALETTE[(loop.order - 1) % PALETTE.length] ?? 'subtle')

export const fillColor = (percent: number) =>
  percent >= DANGER_AT ? 'error' : percent >= WARN_AT ? 'warning' : 'claude'

export const tokens = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`

/** Cells for a fill bar: `full` solid, the rest empty. */
export const fill = (fraction: number, width: number) => {
  const cells = Math.max(1, width)
  const full = Math.min(cells, Math.max(0, Math.round(fraction * cells)))
  return { full: '█'.repeat(full), empty: '░'.repeat(cells - full) }
}

/** Splits `width` cells among loops by their share of the total, each live loop getting at least one. */
export const shares = (list: LoopUsage[], width: number) => {
  const total = list.reduce((s, l) => s + l.contextTokens, 0)
  if (total === 0) return list.map(l => ({ loop: l, cells: 0 }))
  const raw = list.map(l => ({ loop: l, exact: (l.contextTokens / total) * width }))
  const out = raw.map(r => ({ loop: r.loop, cells: Math.max(r.loop.contextTokens > 0 ? 1 : 0, Math.floor(r.exact)) }))
  let left = width - out.reduce((s, o) => s + o.cells, 0)
  const byRemainder = raw
    .map((r, i) => ({ i, rem: r.exact - Math.floor(r.exact) }))
    .sort((a, b) => b.rem - a.rem)
  for (const { i } of byRemainder) {
    if (left <= 0) break
    const o = out[i]
    if (o) {
      o.cells += 1
      left -= 1
    }
  }
  return out
}

const LIMIT_LABEL: Record<string, string> = { five_hour: '5h', seven_day: '7d', spend_limit: 'spend' }

const shortModel = (model: string | undefined) =>
  (model ?? '').replace(/^claude-/, '').replace(/-\d{8}$/, '')

const patchLoop = async ($: EngineInterface, id: string, fn: (l: LoopUsage) => Partial<LoopUsage>) => {
  await update($, loops, (all: Loops) => {
    const order = all[id]?.order ?? (id === MAIN ? 0 : Object.keys(all).filter(k => k !== MAIN).length + 1)
    const base: LoopUsage = all[id] ?? {
      id,
      label: id === MAIN ? 'main' : id.slice(0, 6),
      contextTokens: 0,
      outputTokens: 0,
      isLive: true,
      order,
    }
    return { ...all, [id]: { ...base, ...fn(base) } }
  })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'context-bar',
      description: 'Show or hide the context bar above the prompt',
    })
    return next(e)
  })

  on('command.run', { command: 'context-bar' }, async $ => {
    const hidden = await update($, isHidden, v => !v)
    return { text: hidden ? 'Context bar hidden.' : 'Context bar shown.' }
  })

  on('agent.spawn', async ($, e, next) => {
    const ran = await next(e)
    if (ran.agentId) {
      await patchLoop($, ran.agentId, () => ({
        label: e.subagentType === 'general-purpose' ? e.description : e.subagentType,
        model: ran.model,
        isLive: true,
      }))
    }
    return ran
  })

  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    const usage = result.usage
    if (usage) {
      const id = e.agentId ?? MAIN
      await patchLoop($, id, l => ({
        model: usage.model,
        contextTokens: usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens,
        outputTokens: l.outputTokens + usage.output_tokens,
        isLive: true,
      }))
      if (id === MAIN) {
        const { context } = await $.session.usage()
        const percent = context.percent ?? 0
        const last = await read($, warnedAt)
        if (percent >= WARN_AT && last < WARN_AT) {
          $.ui.toast(`Context at ${percent}%: consider /compact before the next big task`)
          await update($, warnedAt, () => percent)
        } else if (percent < WARN_AT && last >= WARN_AT) {
          await update($, warnedAt, () => 0)
        }
      }
    }
    return result
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId) await patchLoop($, e.agentId, () => ({ isLive: false }))
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await update($, loops, () => ({}))
      await update($, warnedAt, () => 0)
    }
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (await read($, isHidden))) return next(e)

    const all = await read($, loops)
    const detailed = await read($, isDetailed)
    const usage = await $.session.usage()
    const { context } = usage
    const mainTokens = context.tokens ?? all[MAIN]?.contextTokens ?? 0
    if (mainTokens === 0 && Object.keys(all).length === 0) return next(e)

    const { Box, Text, Button } = $.ui.resolve(e)
    const width = e.props.bodyColumns
    const percent = context.percent ?? Math.round((mainTokens / Math.max(1, context.window)) * 100)
    const barWidth = Math.max(8, Math.min(40, width - 48))
    const main = fill(percent / 100, barWidth)

    const list = Object.values(all).sort((a, b) => a.order - b.order)
    const agents = list.filter(l => l.id !== MAIN)
    const totalOut = list.reduce((s, l) => s + l.outputTokens, 0)
    const limit = usage.rateLimits.find(r => r.kind === 'five_hour') ?? usage.rateLimits[0]

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between">
          <Text wrap="truncate-end">
            <Text dimColor>ctx </Text>
            <Text color={fillColor(percent)}>{main.full}</Text>
            <Text dimColor>{main.empty}</Text>
            <Text color={fillColor(percent)} bold>
              {' '}
              {percent}%
            </Text>
            <Text dimColor>
              {' '}
              {tokens(mainTokens)}/{tokens(context.window)}
              {totalOut > 0 ? ` · out ${tokens(totalOut)}` : ''}
              {usage.cost ? ` · $${usage.cost.usd.toFixed(2)}` : ''}
              {limit ? ` · ${LIMIT_LABEL[limit.kind] ?? limit.kind} ${Math.round(limit.percentUsed)}%` : ''}
            </Text>
          </Text>
          {agents.length > 0 && (
            <Button
              key="detail"
              hotkey="d"
              plain
              label={detailed ? 'less' : 'agents'}
              onPress={() => update($, isDetailed, v => !v)}
            />
          )}
        </Box>

        {agents.length > 0 && (
          <Text wrap="truncate-end">
            <Text dimColor>mix </Text>
            {shares(list, barWidth).map(s => (
              <Text color={loopColor(s.loop)} dimColor={!s.loop.isLive && s.loop.id !== MAIN}>
                {'▬'.repeat(s.cells)}
              </Text>
            ))}
            <Text dimColor> live tokens by loop</Text>
          </Text>
        )}

        {detailed &&
          agents.map(loop => {
            const f = fill(loop.contextTokens / Math.max(1, context.window), Math.max(6, Math.floor(barWidth / 2)))
            return (
              <Text key={`loop-${loop.id}`} wrap="truncate-end">
                <Text color={loopColor(loop)}>{loop.isLive ? '●' : '✓'} </Text>
                <Text dimColor={!loop.isLive}>{loop.label.slice(0, 20).padEnd(20)} </Text>
                <Text color={loopColor(loop)}>{f.full}</Text>
                <Text dimColor>{f.empty}</Text>
                <Text dimColor>
                  {' '}
                  {tokens(loop.contextTokens)} ctx · {tokens(loop.outputTokens)} out
                  {loop.model ? ` · ${shortModel(loop.model)}` : ''}
                </Text>
              </Text>
            )
          })}
      </Box>
    )
  })
}
