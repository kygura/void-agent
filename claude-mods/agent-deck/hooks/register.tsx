import { atom, read, update } from 'claude-code'
import type { AgentStatus, EngineInterface, Register } from 'claude-code'

import type { AgentRow, AgentState, DeckView, TaskRow } from '../types'
import { describeTool, formatDuration, formatTokens, glyph, isLive, shortModel, treeOrder } from './format'

const PANE = 'agent-deck'
const MAIN = 'main'

const agents = atom({ plugin: 'agent-deck', key: 'agents' } as const, [])
const tasks = atom({ plugin: 'agent-deck', key: 'tasks' } as const, [])
const view = atom({ plugin: 'agent-deck', key: 'view' } as const, 'all')
const frame = atom({ plugin: 'agent-deck', key: 'frame' } as const, 0)

const STATUS: Record<AgentStatus, AgentState> = {
  pending: 'pending',
  running: 'running',
  waiting: 'waiting',
  idle: 'idle',
  completed: 'done',
  failed: 'failed',
  killed: 'killed',
}

function newRow(id: string, now: number, fields: Partial<AgentRow> = {}): AgentRow {
  return {
    id,
    label: id === MAIN ? 'main' : id.slice(0, 8),
    type: id === MAIN ? 'session' : 'agent',
    state: 'pending',
    steps: 0,
    contextTokens: 0,
    outputTokens: 0,
    toolCount: 0,
    startedAt: now,
    ...fields,
  }
}

async function patch($: EngineInterface, id: string, change: (row: AgentRow) => AgentRow): Promise<void> {
  const now = await $.clock.now()
  await update($, agents, list => {
    const found = list.some(row => row.id === id)
    if (found) return list.map(row => (row.id === id ? change(row) : row))
    return [...list, change(newRow(id, now, id === MAIN ? {} : { parentId: MAIN }))]
  })
}

async function openDeck($: EngineInterface): Promise<boolean> {
  const opened = await $.ui.open({ id: PANE, title: 'Agents' })
  return opened.isPlaced
}

async function reconcile($: EngineInterface): Promise<void> {
  const listed = await $.agent.list()
  if (listed.length === 0) return
  const now = await $.clock.now()
  await update($, agents, rows => {
    let next = rows
    for (const info of listed) {
      const state = STATUS[info.status]
      const known = next.find(row => row.id === info.id)
      if (known === undefined) {
        next = [...next, newRow(info.id, now, { label: info.name ?? info.description, type: info.type, parentId: info.parentId ?? MAIN, state })]
      } else if (known.state !== state && !(known.state === 'done' && state === 'idle')) {
        const ended = state === 'done' || state === 'failed' || state === 'killed'
        next = next.map(row => (row.id === info.id ? { ...row, state, endedAt: ended ? (row.endedAt ?? now) : undefined } : row))
      }
    }
    return next
  })
}

export const register: Register = (on, options) => {
  const openOnSpawn = options.openOnSpawn !== false
  let hasOpened = false

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'deck', description: 'Open the agent panel: agents, models, effort, tools and task progress' })
    let ticks = 0
    $.clock.every(400, () => {
      ticks += 1
      void (async () => {
        const rows = await read($, agents)
        const live = rows.some(isLive)
        if (live) await update($, frame, value => (value + 1) % 1000)
        if (live && ticks % 5 === 0) await reconcile($)
      })()
    })
    return next(e)
  })

  on('command.run', { command: 'deck' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'agents' || arg === 'tasks' || arg === 'all') await update($, view, () => arg as DeckView)
    await reconcile($)
    hasOpened = (await openDeck($)) || hasOpened
    return { text: 'Agent panel opened (ctrl+x tab to focus, a/g/t to switch view).' }
  })

  on('turn.start', async ($, e, next) => {
    const now = await $.clock.now()
    await patch($, MAIN, row => ({ ...row, state: 'running', startedAt: now, endedAt: undefined }))
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const id = e.agentId ?? MAIN
    const effort = e.effort === undefined ? undefined : String(e.effort)
    await patch($, id, row => ({ ...row, model: e.model, effort, state: 'running' }))
    const result = yield* next(e)
    const usage = result.usage
    await patch($, id, row => ({
      ...row,
      model: usage?.model || row.model,
      steps: row.steps + 1,
      contextTokens: usage === null ? row.contextTokens : usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens + usage.output_tokens,
      outputTokens: row.outputTokens + (usage?.output_tokens ?? 0),
    }))
    return result
  })

  on('tool.call', async ($, e, next) => {
    const id = e.agentId ?? MAIN
    const doing = describeTool(String(e.tool), e as unknown as Record<string, unknown>)
    await patch($, id, row => ({ ...row, currentTool: doing }))

    if (e.tool === 'TodoWrite') {
      const todos: TaskRow[] = e.todos.map((todo, index) => ({
        id: `todo-${index}`,
        subject: todo.content,
        activeForm: todo.activeForm,
        state: todo.status,
      }))
      await update($, tasks, () => todos)
    }

    const ran = await next(e)

    await patch($, id, row => ({ ...row, currentTool: undefined, lastTool: doing, toolCount: row.toolCount + 1 }))

    if (ran.deny === undefined && ran.isError !== true) {
      if (e.tool === 'TaskCreate') {
        const record = ran.result as { task?: { id: string; subject: string } } | undefined
        const task = record?.task
        if (task !== undefined) {
          await update($, tasks, list => [
            ...list.filter(row => row.id !== task.id),
            { id: task.id, subject: task.subject, activeForm: e.activeForm, state: 'pending' as const },
          ])
        }
      }
      if (e.tool === 'TaskUpdate') {
        const { taskId, status, subject, activeForm, owner } = e
        await update($, tasks, list =>
          status === 'deleted'
            ? list.filter(row => row.id !== taskId)
            : list.map(row =>
                row.id === taskId
                  ? { ...row, state: status ?? row.state, subject: subject ?? row.subject, activeForm: activeForm ?? row.activeForm, owner: owner ?? row.owner }
                  : row,
              ),
        )
      }
    }
    return ran
  }).catch(($, e, next) => next(e))

  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    const agentId = started.agentId
    if (agentId !== undefined) {
      const now = await $.clock.now()
      await update($, agents, list => [
        ...list.filter(row => row.id !== agentId),
        newRow(agentId, now, {
          label: e.name ?? (e.description || e.subagentType),
          type: e.isTeammate ? 'teammate' : e.subagentType,
          parentId: e.parentAgentId ?? MAIN,
          model: started.model,
          state: 'running',
        }),
      ])
      if (openOnSpawn && !hasOpened) hasOpened = await openDeck($)
    }
    return started
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const now = await $.clock.now()
    const agentId = e.agentId
    if (agentId === undefined) {
      await patch($, MAIN, row => ({ ...row, state: 'idle', currentTool: undefined, endedAt: now }))
    } else {
      const state: AgentState = e.reason === 'answer' ? 'done' : e.reason === 'aborted' ? 'killed' : 'failed'
      await patch($, agentId, row => ({ ...row, state, currentTool: undefined, endedAt: now }))
    }
    return next(e)
  })

  on('session.end', { reason: 'clear' }, async ($, e, next) => {
    await update($, agents, () => [])
    await update($, tasks, () => [])
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const rows = await read($, agents)
    const taskRows = await read($, tasks)
    const shown = await read($, view)
    const tick = await read($, frame)
    const now = await $.clock.now()
    const columns = e.props.bodyColumns
    const viewed = e.props.view.agentId ?? MAIN

    const live = rows.filter(isLive).length
    const finished = rows.filter(row => row.state === 'done').length
    const failed = rows.filter(row => row.state === 'failed' || row.state === 'killed').length
    const completedTasks = taskRows.filter(task => task.state === 'completed').length
    const labelWidth = Math.max(8, Math.min(20, Math.floor(columns / 4)))

    const summary = [
      `${live} live`,
      finished > 0 ? `${finished} done` : '',
      failed > 0 ? `${failed} failed` : '',
      taskRows.length > 0 ? `${completedTasks}/${taskRows.length} tasks` : '',
    ]
      .filter(Boolean)
      .join(' · ')

    const viewButton = (key: DeckView, label: string, hotkey: string) => (
      <Button key={`view-${key}`} plain hotkey={hotkey} dimColor={shown !== key} label={label} onPress={() => update($, view, () => key)} />
    )

    const agentSection = (
      <Box flexDirection="column">
        {rows.length === 0 && <Text dimColor>No agent activity yet.</Text>}
        {treeOrder(rows).map(({ row, depth, isLast }) => {
          const mark = glyph(row.state, tick)
          const branch = depth === 0 ? '' : `${'  '.repeat(depth - 1)}${isLast ? '└ ' : '├ '}`
          const elapsed = formatDuration((row.endedAt ?? now) - row.startedAt)
          const activity = row.currentTool ?? (row.lastTool ? `last: ${row.lastTool}` : '')
          const isDim = row.state === 'done' || row.state === 'killed' || row.state === 'idle'
          return (
            <Box flexDirection="row" gap={1}>
              <Text dimColor>{branch}</Text>
              <Text color={mark.color}>{mark.text}</Text>
              <Text bold={row.id === viewed} dimColor={isDim} wrap="truncate-end">
                {row.label.slice(0, labelWidth).padEnd(labelWidth - branch.length)}
              </Text>
              <Text color="suggestion">
                {shortModel(row.model)}
                {row.effort ? `·${row.effort}` : ''}
              </Text>
              <Text dimColor>
                s{row.steps} ctx {formatTokens(row.contextTokens)} {elapsed}
              </Text>
              <Text dimColor={row.currentTool === undefined} wrap="truncate-end">
                {activity}
              </Text>
            </Box>
          )
        })}
      </Box>
    )

    const progress = taskRows.length === 0 ? 0 : completedTasks / taskRows.length
    const barWidth = Math.max(10, Math.min(30, columns - 20))
    const filled = Math.round(progress * barWidth)
    const taskSection = (
      <Box flexDirection="column">
        {taskRows.length === 0 ? (
          <Text dimColor>No tasks yet.</Text>
        ) : (
          <Box flexDirection="row" gap={1}>
            <Text>
              <Text color="success">{'▰'.repeat(filled)}</Text>
              <Text dimColor>{'▱'.repeat(barWidth - filled)}</Text>
            </Text>
            <Text bold>{Math.round(progress * 100)}%</Text>
            <Text dimColor>
              {completedTasks}/{taskRows.length}
            </Text>
          </Box>
        )}
        {taskRows.map(task => {
          const mark = glyph(task.state, tick)
          const text = task.state === 'in_progress' ? (task.activeForm ?? task.subject) : task.subject
          return (
            <Box flexDirection="row" gap={1}>
              <Text color={mark.color}>{mark.text}</Text>
              <Text dimColor={task.state === 'completed'} strikethrough={task.state === 'completed'} bold={task.state === 'in_progress'} wrap="truncate-end">
                {text}
                {task.owner ? ` (${task.owner})` : ''}
              </Text>
            </Box>
          )
        })}
      </Box>
    )

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" gap={2}>
          <Text bold>{summary}</Text>
          {viewButton('all', 'all', 'a')}
          {viewButton('agents', 'agents', 'g')}
          {viewButton('tasks', 'tasks', 't')}
          {finished + failed > 0 && (
            <Button
              key="clear"
              plain
              dimColor
              hotkey="c"
              label="clear done"
              onPress={() => update($, agents, list => list.filter(row => row.id === MAIN || isLive(row)))}
            />
          )}
        </Box>
        {shown !== 'tasks' && agentSection}
        {shown !== 'agents' && taskSection}
      </Box>
    )
  })
}
