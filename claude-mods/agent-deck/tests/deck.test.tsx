import { expect, mock, test } from 'claude-code/testing'
import type { TurnStepResult } from 'claude-code'

const PANE = {
  plugin: 'agent-deck',
  component: 'Pane',
  requestId: 'agent-deck',
  props: { title: 'Agents', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

test('tracks agents, their models and tools, and task progress', { options: { openOnSpawn: false } }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('agent.spawn', () => ({ model: 'claude-haiku-4-5', agentId: 'scout1' }))
  on('turn.step', async function* ($, e): AsyncGenerator<never, TurnStepResult> {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      stopReason: 'tool_use',
      usage: { model: e.model, input_tokens: 2000, output_tokens: 300, cache_read_input_tokens: 40_000, cache_creation_input_tokens: 0 },
    }
  })
  on('tool.call', ($, e) => {
    if (e.tool === 'TaskCreate') return { result: { task: { id: '7', subject: e.subject } } }
    if (e.tool === 'TaskUpdate') return { result: { success: true, taskId: e.taskId, updatedFields: ['status'] } }
    return { result: {} }
  })

  await $.turn.start({ text: 'build mods', turnId: 't1' })
  const step = $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', effort: 'high', messageCount: 1 })
  for await (const chunk of step) void chunk
  await step.result

  await $.agent.spawn({
    tool_use_id: 'tu1',
    prompt: 'Map the hooks API',
    description: 'map hooks',
    subagentType: 'Explore',
    name: 'scout',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'claude-opus-5-5',
    background: true,
    fork: false,
  })
  const subStep = $.turn.step({ turnId: 't2', index: 0, model: 'claude-haiku-4-5', effort: 'low', messageCount: 1, agentId: 'scout1' })
  for await (const chunk of subStep) void chunk
  await subStep.result

  await $.tool.call({
    tool: 'TodoWrite',
    todos: [
      { content: 'Map the API', status: 'completed', activeForm: 'Mapping the API' },
      { content: 'Write the mods', status: 'in_progress', activeForm: 'Writing the mods' },
      { content: 'Validate', status: 'pending', activeForm: 'Validating' },
    ],
  })
  await $.tool.call({ tool: 'TaskCreate', subject: 'Publish', description: 'Push and open the PR' })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /scout/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'haiku-4.5·low' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'opus-5.5·high' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /ctx 42\.3k/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Writing the mods' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '1/4' })).toBeDefined()

    await ui.press({ key: 'view-tasks' })
    expect(await ui.find({ type: 'Text', text: /scout/ })).toBeUndefined()
    await ui.press({ key: 'view-all' })
    await ui.unmount()
  }

  await clock.advance(12_000)
  await $.tool.call({ tool: 'TaskUpdate', taskId: '7', status: 'completed' })
  await $.turn.complete({ answer: 'done', durationMs: 1000, isAborted: false, turnId: 't2', agentId: 'scout1', reason: 'answer' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: '2/4' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /1 done/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /12s/ })).toBeDefined()
  await ui.press({ key: 'clear' })
  expect(await ui.find({ type: 'Text', text: /scout/ })).toBeUndefined()
})
