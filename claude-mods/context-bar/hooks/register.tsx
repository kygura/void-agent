import { atom, read, update } from 'claude-code'
import type { Register, SessionContextUsage, SessionCost, SessionRateLimit } from 'claude-code'

import type { AgentUsage, Measure } from '../types'
import { AGENT_COLORS, bar, fillColor, formatTokens, rateLabel, shortModel, windowFor } from './format'

const measure = atom({ plugin: 'context-bar', key: 'measure' } as const, null)
const agents = atom({ plugin: 'context-bar', key: 'agents' } as const, [])
const isExpanded = atom({ plugin: 'context-bar', key: 'isExpanded' } as const, false)

const MAIN = 'main'
const MAX_AGENTS = 8

function toMeasure(context: SessionContextUsage, rateLimits: readonly SessionRateLimit[], cost?: SessionCost): Measure {
  return {
    tokens: context.tokens,
    window: context.window,
    percent: context.percent,
    costUsd: cost?.usd,
    rateLimits: rateLimits.map(limit => ({ kind: limit.kind, percentUsed: limit.percentUsed, resetsAt: limit.resetsAt })),
  }
}

function blankAgent(id: string, label: string): AgentUsage {
  return { id, label, model: '', contextTokens: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, steps: 0, isDone: false }
}

function upsert(list: AgentUsage[], id: string, change: (agent: AgentUsage) => AgentUsage, label = id): AgentUsage[] {
  const found = list.find(agent => agent.id === id)
  const next = change(found ?? blankAgent(id, label))
  const rest = list.filter(agent => agent.id !== id)
  const merged = found ? list.map(agent => (agent.id === id ? next : agent)) : [...rest, next]
  // Keep main first, then the newest subagents.
  const main = merged.filter(agent => agent.id === MAIN)
  const subs = merged.filter(agent => agent.id !== MAIN).slice(-MAX_AGENTS)
  return [...main, ...subs]
}

export const register: Register = (on, options) => {
  const warnAt = typeof options.warnAt === 'number' ? options.warnAt : 80
  let warned = false

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'ctx', description: 'Context window by category, and each agent\'s token spend' })
    const usage = await $.session.usage()
    await update($, measure, () => toMeasure(usage.context, usage.rateLimits, usage.cost))
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    await update($, measure, () => toMeasure(e.context, e.rateLimits, e.cost))
    const percent = e.context.percent ?? 0
    if (percent >= warnAt && !warned) {
      warned = true
      $.ui.toast(`Context at ${percent}%: consider /compact or handing work to a subagent`, { timeoutMs: 8000 })
    }
    if (percent < warnAt) warned = false
    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    const agentId = started.agentId
    if (agentId !== undefined) {
      const label = e.name ?? (e.description || e.subagentType)
      await update($, agents, list =>
        upsert(list, agentId, agent => ({ ...agent, label, model: started.model ?? agent.model }), label),
      )
    }
    return started
  }).catch(($, e, next) => next(e))

  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    const usage = result.usage
    if (usage !== null) {
      const id = e.agentId ?? MAIN
      await update($, agents, list =>
        upsert(list, id, agent => ({
          ...agent,
          model: usage.model || e.model,
          effort: e.effort === undefined ? undefined : String(e.effort),
          contextTokens: usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens + usage.output_tokens,
          inputTokens: agent.inputTokens + usage.input_tokens + usage.cache_creation_input_tokens,
          cacheReadTokens: agent.cacheReadTokens + usage.cache_read_input_tokens,
          outputTokens: agent.outputTokens + usage.output_tokens,
          steps: agent.steps + 1,
          isDone: false,
        })),
      )
    }
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const agentId = e.agentId
    if (agentId !== undefined) {
      await update($, agents, list => list.map(agent => (agent.id === agentId ? { ...agent, isDone: true } : agent)))
    }
    return next(e)
  })

  on('session.end', { reason: 'clear' }, async ($, e, next) => {
    await update($, agents, () => [])
    warned = false
    return next(e)
  })

  on('command.run', { command: 'ctx' }, async $ => {
    const usage = await $.session.usage({ breakdown: 'summary' })
    const breakdown = usage.context.breakdown
    const lines: string[] = []
    if (breakdown !== undefined) {
      lines.push(`**${breakdown.model}**: ${formatTokens(breakdown.totalTokens)} of ${formatTokens(breakdown.rawMaxTokens)} (${breakdown.percentage}%)`, '')
      lines.push('| Category | Tokens | Share |', '| --- | ---: | ---: |')
      for (const row of breakdown.categories) {
        if (row.tokens <= 0 || row.isDeferred) continue
        const share = Math.round((row.tokens / Math.max(1, breakdown.rawMaxTokens)) * 100)
        lines.push(`| ${row.name} | ${formatTokens(row.tokens)} | ${share}% |`)
      }
    } else {
      lines.push(`Context: ${formatTokens(usage.context.tokens ?? 0)} of ${formatTokens(usage.context.window)}`)
    }
    const list = await read($, agents)
    if (list.length > 0) {
      lines.push('', '| Agent | Model | Effort | Context | In | Cached | Out | Steps |', '| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |')
      for (const agent of list) {
        lines.push(
          `| ${agent.label}${agent.isDone ? ' (done)' : ''} | ${shortModel(agent.model)} | ${agent.effort ?? '-'} | ${formatTokens(agent.contextTokens)} | ${formatTokens(agent.inputTokens)} | ${formatTokens(agent.cacheReadTokens)} | ${formatTokens(agent.outputTokens)} | ${agent.steps} |`,
        )
      }
    }
    if (usage.cost !== undefined) lines.push('', `Session cost: $${usage.cost.usd.toFixed(2)}`)
    return { text: lines.join('\n') }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const current = await read($, measure)
    const list = await read($, agents)
    if (current === null && list.length === 0) return next(e)

    const expanded = await read($, isExpanded)
    const { Box, Text, Button } = $.ui.resolve(e)
    const columns = e.props.bodyColumns
    const window = current?.window ?? 200_000
    const tokens = current?.tokens ?? list.find(agent => agent.id === MAIN)?.contextTokens ?? 0
    const percent = current?.percent ?? Math.round((tokens / window) * 100)
    const barWidth = Math.max(8, Math.min(30, columns - 60))
    const main = bar(tokens / window, barWidth)
    const subs = list.filter(agent => agent.id !== MAIN)
    const viewed = e.props.view.agentId

    const limits = (current?.rateLimits ?? []).map(limit => `${rateLabel(limit.kind)} ${Math.round(limit.percentUsed)}%`).join(' · ')
    const spend = list.reduce((sum, agent) => sum + agent.inputTokens + agent.cacheReadTokens + agent.outputTokens, 0)

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1}>
          <Text dimColor>ctx</Text>
          <Text>
            <Text color={fillColor(percent)}>{main.filled}</Text>
            <Text dimColor>{main.empty}</Text>
          </Text>
          <Text bold color={fillColor(percent)}>{percent}%</Text>
          <Text dimColor wrap="truncate-end">
            {formatTokens(tokens)}/{formatTokens(window)}
            {current?.costUsd !== undefined ? `  $${current.costUsd.toFixed(2)}` : ''}
            {limits ? `  ${limits}` : ''}
            {subs.length > 0 ? `  Σ${formatTokens(spend)} over ${subs.length + 1} agents` : ''}
          </Text>
          {subs.length > 0 && (
            <Button
              key="toggle"
              plain
              dimColor
              label={expanded ? '[less]' : '[agents]'}
              onPress={() => update($, isExpanded, value => !value)}
            />
          )}
        </Box>
        {subs.length > 0 && !expanded && (
          <Box flexDirection="row" gap={2} flexWrap="wrap">
            {list.map((agent, index) => (
              <Text color={agent.isDone ? 'inactive' : AGENT_COLORS[index % AGENT_COLORS.length]} bold={agent.id === (viewed ?? MAIN)}>
                {agent.isDone ? '✓' : '●'} {agent.label.slice(0, 18)} {formatTokens(agent.contextTokens)}
              </Text>
            ))}
          </Box>
        )}
        {expanded &&
          list.map((agent, index) => {
            const agentWindow = agent.id === MAIN ? window : windowFor(agent.model, window)
            const fill = agent.contextTokens / agentWindow
            const agentBar = bar(fill, 12)
            const color = AGENT_COLORS[index % AGENT_COLORS.length] ?? 'claude'
            return (
              <Box flexDirection="row" gap={1}>
                <Text color={agent.isDone ? 'inactive' : color} bold={agent.id === (viewed ?? MAIN)}>
                  {agent.isDone ? '✓' : '●'} {agent.label.slice(0, 16).padEnd(16)}
                </Text>
                <Text>
                  <Text color={color}>{agentBar.filled}</Text>
                  <Text dimColor>{agentBar.empty}</Text>
                </Text>
                <Text dimColor wrap="truncate-end">
                  {String(Math.round(fill * 100)).padStart(3)}% {formatTokens(agent.contextTokens).padStart(6)}
                  {'  '}
                  {shortModel(agent.model)}
                  {agent.effort ? `·${agent.effort}` : ''}
                  {'  '}in {formatTokens(agent.inputTokens)} cached {formatTokens(agent.cacheReadTokens)} out {formatTokens(agent.outputTokens)} · {agent.steps} steps
                </Text>
              </Box>
            )
          })}
      </Box>
    )
  })
}
