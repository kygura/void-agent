import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, TurnUsage } from 'claude-code'

const PANE = {
  component: 'Pane',
  requestId: 'agent-deck',
  props: {
    title: 'Agents',
    isFocused: false,
    bodyColumns: 70,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const usage = (input: number, output: number, model: string): TurnUsage => ({
  input_tokens: input,
  output_tokens: output,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
  model,
})

const step = async ($: Engine, agentId: string | undefined, u: TurnUsage) => {
  const stream = $.turn.step({ turnId: 't1', index: 0, model: u.model, effort: 'high', messageCount: 3, agentId })
  for await (const _chunk of stream) {
    // drain
  }
  return stream.result
}

const boot = async ($: Engine, on: On) => {
  mock.clock(on)
  on('session.start', () => ({ cwd: '/repo' }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } as const }))
  on('agent.list', () => ({ value: [] }))
  on('agent.spawn', () => ({ model: 'claude-haiku-4-5', agentId: 'agent-1' }))
  on('turn.step', async function* (_$, e) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      stopReason: 'end_turn',
      usage: usage(e.agentId ? 31_000 : 82_000, 1_200, e.model),
    }
  })
  on('tool.call', { tool: 'TodoWrite' }, (_$, e) => ({ result: { oldTodos: [], newTodos: e.todos } }))
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
}

test('lists main and subagents with model, effort, tokens and task progress', async ($, on) => {
  await boot($, on)
  await $.agent.spawn({
    tool_use_id: 'tu-1',
    prompt: 'find auth code',
    description: 'find auth code',
    subagentType: 'Explore',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'claude-opus-5-5',
    background: true,
    fork: false,
  })
  await step($, undefined, usage(82_000, 1_200, 'claude-opus-5-5'))
  await step($, 'agent-1', usage(31_000, 1_200, 'claude-haiku-4-5'))
  await $.tool.call({
    tool: 'TodoWrite',
    todos: [
      { content: 'Read the spec', status: 'completed', activeForm: 'Reading the spec' },
      { content: 'Write the mod', status: 'in_progress', activeForm: 'Writing the mod' },
      { content: 'Test it', status: 'pending', activeForm: 'Testing it' },
    ],
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'agent-deck', surface, ...PANE })
    expect(await ui.find({ type: 'Text', text: /Explore: find auth code/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /opus-5-5 · high/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /ctx 31k/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /1\/3/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Writing the mod/ })).toBeDefined()

    await ui.press({ key: 'compact' })
    expect(await ui.find({ type: 'Text', text: /ctx 31k/ })).toBeUndefined()
    await ui.press({ key: 'compact' })
    await ui.unmount()
  }
})
