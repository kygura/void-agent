import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AgentRow, AgentStatus, TaskItem, TaskStatus } from '../types'

const PANE = 'agent-deck'
const MAIN = 'main'

const agents = atom({ plugin: 'agent-deck', key: 'agents' } as const, {})
const tasks = atom({ plugin: 'agent-deck', key: 'tasks' } as const, [])
const isCompact = atom({ plugin: 'agent-deck', key: 'isCompact' } as const, false)
const now = atom({ plugin: 'agent-deck', key: 'now' } as const, 0)

type Agents = Record<string, AgentRow>

const freshRow = (id: string, startedAt: number, patch: Partial<AgentRow> = {}): AgentRow => ({
  id,
  label: id === MAIN ? 'main' : id.slice(0, 8),
  type: id === MAIN ? 'main' : 'agent',
  status: 'running',
  steps: 0,
  toolCalls: 0,
  contextTokens: 0,
  outputTokens: 0,
  startedAt,
  ...patch,
})

const patchAgent = async (
  $: EngineInterface,
  id: string,
  fn: (row: AgentRow) => Partial<AgentRow>,
) => {
  const at = await $.clock.now()
  await update($, agents, (all: Agents) => {
    const row = all[id] ?? freshRow(id, at)
    return { ...all, [id]: { ...row, ...fn(row) } }
  })
}

export const shortModel = (model: string | undefined) =>
  (model ?? '?')
    .replace(/^claude-/, '')
    .replace(/-\d{8}$/, '')
    .replace(/\[1m\]$/, '·1m')

export const tokens = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`

export const elapsed = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000))
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s` : `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`
}

export const bar = (done: number, total: number, width: number) => {
  const cells = Math.max(1, width)
  const full = total === 0 ? 0 : Math.round((done / total) * cells)
  return '▰'.repeat(full) + '▱'.repeat(cells - full)
}

const STATUS_GLYPH: Record<AgentStatus, string> = {
  running: '●',
  idle: '◌',
  done: '✓',
  failed: '✗',
  aborted: '■',
}

const STATUS_COLOR: Record<AgentStatus, string> = {
  running: 'claude',
  idle: 'subtle',
  done: 'success',
  failed: 'error',
  aborted: 'warning',
}

const TASK_GLYPH: Record<TaskStatus, string> = { pending: '○', in_progress: '▸', completed: '✓' }

const isTaskStatus = (s: unknown): s is TaskStatus =>
  s === 'pending' || s === 'in_progress' || s === 'completed'

/** Main loop first, then each agent under its parent in spawn order. */
export const ordered = (all: Agents): { row: AgentRow; depth: number }[] => {
  const rows = Object.values(all).sort((a, b) => a.startedAt - b.startedAt)
  const out: { row: AgentRow; depth: number }[] = []
  const walk = (parent: string | undefined, depth: number) => {
    for (const row of rows) {
      const p = row.id === MAIN ? undefined : (row.parentId ?? MAIN)
      if (row.id !== MAIN && p === parent) {
        out.push({ row, depth })
        walk(row.id, depth + 1)
      }
    }
  }
  const main = all[MAIN]
  if (main) out.push({ row: main, depth: 0 })
  walk(MAIN, 1)
  // Orphans whose parent row is gone.
  for (const row of rows) if (!out.some(o => o.row.id === row.id)) out.push({ row, depth: 1 })
  return out
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'agent-deck',
      description: 'Open the agent panel: agents, models, effort, tokens and task progress',
    })
    const at = await $.clock.now()
    await update($, agents, (all: Agents) => ({ [MAIN]: all[MAIN] ?? freshRow(MAIN, at, { status: 'idle' }), ...all }))
    await update($, now, () => at)

    // Tick the clock once a second while anything runs, so elapsed times move.
    $.clock.every(1000, () => {
      void (async () => {
        const all = await read($, agents)
        if (Object.values(all).some(a => a.status === 'running')) {
          const t = await $.clock.now()
          await update($, now, () => t)
        }
      })()
    })

    // Resync agent status with the engine every few seconds (teammates idle, kills).
    $.clock.every(4000, () => {
      void (async () => {
        const list = await $.agent.list()
        const at = await $.clock.now()
        await update($, agents, (all: Agents) => {
          let changed = false
          const out = { ...all }
          for (const info of list) {
            const status: AgentStatus | undefined =
              info.status === 'running' || info.status === 'pending' || info.status === 'waiting'
                ? 'running'
                : info.status === 'idle'
                  ? 'idle'
                  : info.status === 'completed'
                    ? 'done'
                    : info.status === 'failed'
                      ? 'failed'
                      : info.status === 'killed'
                        ? 'aborted'
                        : undefined
            const row = out[info.id]
            if (!row) {
              out[info.id] = freshRow(info.id, at, {
                label: info.description || info.name || info.id.slice(0, 8),
                type: info.type,
                parentId: info.parentId,
                status: status ?? 'running',
              })
              changed = true
            } else if (status && row.status !== status && row.status !== 'failed') {
              out[info.id] = { ...row, status, tool: undefined, endedAt: status === 'running' ? undefined : (row.endedAt ?? at) }
              changed = true
            }
          }
          return changed ? out : all
        })
      })()
    })

    void $.ui.open({ id: PANE, title: 'Agents' })
    return next(e)
  })

  on('command.run', { command: 'agent-deck' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Agents', focus: true })
    return { text: 'Agent panel opened.' }
  })

  on('agent.spawn', async ($, e, next) => {
    const ran = await next(e)
    if (ran.agentId) {
      const id = ran.agentId
      await patchAgent($, id, () => ({
        label: e.description,
        type: e.subagentType,
        parentId: e.parentAgentId,
        model: ran.model,
        status: 'running',
      }))
    }
    return ran
  })

  on('turn.start', async ($, e, next) => {
    await patchAgent($, MAIN, () => ({ status: 'running', endedAt: undefined }))
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const id = e.agentId ?? MAIN
    await patchAgent($, id, row => ({
      model: e.model,
      effort: e.effort === undefined ? row.effort : String(e.effort),
      status: 'running',
    }))
    const result = yield* next(e)
    const usage = result.usage
    await patchAgent($, id, row => ({
      steps: row.steps + 1,
      model: usage?.model ?? row.model,
      contextTokens: usage
        ? usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens
        : row.contextTokens,
      outputTokens: row.outputTokens + (usage?.output_tokens ?? 0),
    }))
    return result
  })

  on('tool.call', async ($, e, next) => {
    const id = e.agentId ?? MAIN
    await patchAgent($, id, row => ({ tool: String(e.tool), toolCalls: row.toolCalls + 1 }))
    const ran = await next(e)
    await patchAgent($, id, row => (row.tool === String(e.tool) ? { tool: undefined } : {}))
    return ran
  })

  // Task progression: TodoWrite replaces a list, TaskCreate/TaskUpdate edit one task.
  on('tool.call', { tool: 'TodoWrite' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && !ran.isError) {
      const owner = e.agentId ?? MAIN
      await update($, tasks, (list: TaskItem[]) => [
        ...list.filter(t => t.agentId !== owner || !t.id.startsWith('todo:')),
        ...e.todos.map((t, i) => ({
          id: `todo:${owner}:${i}`,
          subject: t.content,
          status: t.status,
          activeForm: t.activeForm,
          agentId: owner,
        })),
      ])
    }
    return ran
  })

  on('tool.call', { tool: 'TaskCreate' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && !ran.isError && ran.result) {
      const created = ran.result.task
      const item: TaskItem = {
        id: created.id,
        subject: created.subject,
        status: 'pending',
        activeForm: e.activeForm,
        agentId: e.agentId ?? MAIN,
      }
      await update($, tasks, (list: TaskItem[]) => [...list.filter(t => t.id !== item.id), item])
    }
    return ran
  })

  on('tool.call', { tool: 'TaskUpdate' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && !ran.isError) {
      await update($, tasks, (list: TaskItem[]) =>
        e.status === 'deleted'
          ? list.filter(t => t.id !== e.taskId)
          : list.map(t =>
              t.id === e.taskId
                ? {
                    ...t,
                    subject: e.subject ?? t.subject,
                    activeForm: e.activeForm ?? t.activeForm,
                    status: isTaskStatus(e.status) ? e.status : t.status,
                    agentId: e.agentId ?? MAIN,
                  }
                : t,
            ),
      )
    }
    return ran
  })

  on('turn.complete', async ($, e, next) => {
    const id = e.agentId ?? MAIN
    const status: AgentStatus =
      e.reason === 'aborted' ? 'aborted' : e.reason === 'answer' ? (id === MAIN ? 'idle' : 'done') : 'failed'
    const at = await $.clock.now()
    await patchAgent($, id, () => ({ status, tool: undefined, endedAt: at }))
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      const at = await $.clock.now()
      await update($, agents, () => ({ [MAIN]: freshRow(MAIN, at, { status: 'idle' }) }))
      await update($, tasks, () => [])
    }
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const all = await read($, agents)
    const list = await read($, tasks)
    const compact = await read($, isCompact)
    const t = await read($, now)
    const width = e.props.bodyColumns

    const rows = ordered(all)
    const running = rows.filter(r => r.row.status === 'running' && r.row.id !== MAIN).length
    const finished = rows.filter(r => r.row.status === 'done').length
    const doneTasks = list.filter(x => x.status === 'completed').length
    const active = list.find(x => x.status === 'in_progress')

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between">
          <Text bold>
            {running} running · {finished} done
          </Text>
          <Box flexDirection="row" gap={1}>
            <Button
              key="compact"
              hotkey="c"
              plain
              label={compact ? 'detail' : 'compact'}
              onPress={() => update($, isCompact, v => !v)}
            />
            <Button
              key="clear"
              hotkey="x"
              plain
              label="clear done"
              onPress={() =>
                update($, agents, (a: Agents) =>
                  Object.fromEntries(
                    Object.entries(a).filter(([k, r]) => k === MAIN || r.status === 'running' || r.status === 'idle'),
                  ),
                )
              }
            />
          </Box>
        </Box>

        {rows.map(({ row, depth }) => {
          const indent = depth === 0 ? '' : `${'  '.repeat(depth - 1)}└ `
          const clock = elapsed((row.endedAt ?? t) - row.startedAt)
          const meta = `${shortModel(row.model)}${row.effort ? ` · ${row.effort}` : ''}`
          return (
            <Box key={`agent-${row.id}`} flexDirection="column">
              <Box flexDirection="row">
                <Text wrap="truncate-end">
                  {indent}
                  <Text color={STATUS_COLOR[row.status]}>{STATUS_GLYPH[row.status]}</Text>{' '}
                  <Text bold={row.id === MAIN}>{row.type === row.label ? row.label : `${row.type}: ${row.label}`}</Text>
                  <Text dimColor> {meta}</Text>
                </Text>
              </Box>
              {!compact && (
                <Text dimColor wrap="truncate-end">
                  {depth === 0 ? '  ' : `${'  '.repeat(depth)}  `}ctx {tokens(row.contextTokens)} · out {tokens(row.outputTokens)} · {row.steps} steps · {row.toolCalls} tools · {clock}
                  {row.tool ? <Text color="suggestion"> ⟳ {row.tool}</Text> : ''}
                </Text>
              )}
            </Box>
          )
        })}

        {list.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text>
              <Text bold>Tasks </Text>
              <Text color={doneTasks === list.length ? 'success' : 'claude'}>
                {bar(doneTasks, list.length, Math.min(20, Math.max(5, width - 18)))}
              </Text>
              <Text dimColor>
                {' '}
                {doneTasks}/{list.length}
              </Text>
            </Text>
            {active && (
              <Text color="claude" wrap="truncate-end">
                ▸ {active.activeForm ?? active.subject}
              </Text>
            )}
            {!compact &&
              list.map(x => (
                <Text key={`task-${x.id}`} dimColor={x.status === 'completed'} wrap="truncate-end">
                  {TASK_GLYPH[x.status]} {x.subject}
                  {x.agentId !== MAIN ? <Text dimColor> ({all[x.agentId]?.type ?? 'agent'})</Text> : ''}
                </Text>
              ))}
          </Box>
        )}
      </Box>
    )
  })
}
