import { expect, test } from 'claude-code/testing'
import type { TurnStepResult } from 'claude-code'

const BAND = {
  plugin: 'context-bar',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 110, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const

test('draws the main fill, then each agent on request', async ($, on) => {
  on('session.measure', ($, e) => ({ changed: [...e.changed] }))
  on('agent.spawn', () => ({ model: 'claude-haiku-4-5', agentId: 'a1' }))
  on('turn.step', async function* ($, e): AsyncGenerator<never, TurnStepResult> {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      stopReason: 'end_turn',
      usage: { model: 'claude-haiku-4-5', input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 10_500, cache_creation_input_tokens: 0 },
    }
  })

  await $.session.measure({
    context: { tokens: 50_000, window: 200_000, percent: 25 },
    rateLimits: [{ kind: 'five_hour', percentUsed: 34 }],
    cost: { usd: 1.5 },
    changed: ['context', 'rateLimits', 'cost'],
  })
  await $.agent.spawn({
    tool_use_id: 'tu1',
    prompt: 'Find the hooks',
    description: 'scout hooks',
    subagentType: 'Explore',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'claude-opus-5-5',
    background: true,
    fork: false,
  })
  const stream = $.turn.step({ turnId: 't1', index: 0, model: 'claude-haiku-4-5', effort: 'low', messageCount: 3, agentId: 'a1' })
  for await (const chunk of stream) void chunk
  await stream.result

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect((await ui.find({ type: 'Text', text: '25%' }))?.text).toBe('25%')
    expect(await ui.find({ type: 'Text', text: /\$1\.50/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /5h 34%/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /scout hooks 12\.0k/ })).toBeDefined()

    await ui.press({ key: 'toggle' })
    expect(await ui.find({ type: 'Text', text: /haiku-4\.5·low/ })).toBeDefined()
    await ui.press({ key: 'toggle' })
    await ui.unmount()
  }
})

test('passes while a survey holds the band', async ($, on) => {
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  on('session.measure', ($, e) => ({ changed: [...e.changed] }))
  await $.session.measure({ context: { tokens: 1000, window: 200_000, percent: 1 }, rateLimits: [], changed: ['context'] })

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal', props: { ...BAND.props, hasSurvey: true } })
  expect(await ui.find({ text: 'engine' })).toBeDefined()
})
