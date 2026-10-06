import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, RenderElement } from 'claude-code'

const BAND = {
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: true,
    maxRows: 10,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

const step = async ($: Engine, agentId: string | undefined, model: string) => {
  const stream = $.turn.step({ turnId: 't1', index: 0, model, messageCount: 3, agentId })
  for await (const _chunk of stream) {
    // drain
  }
}

const boot = async ($: Engine, on: On, toasts: string[], percent: number) => {
  on('session.start', () => ({ cwd: '/repo' }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { tokens: percent * 2000, window: 200_000, percent },
      rateLimits: [{ kind: 'five_hour', percentUsed: 34 }],
      cost: { usd: 1.42 },
    },
  }))
  on('agent.spawn', () => ({ model: 'claude-haiku-4-5', agentId: 'agent-1' }))
  on('turn.step', async function* (_$, e) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      stopReason: 'end_turn',
      usage: {
        input_tokens: 1000,
        cache_read_input_tokens: e.agentId ? 30_000 : percent * 2000 - 1000,
        cache_creation_input_tokens: 0,
        output_tokens: 500,
        model: e.model,
      },
    }
  })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
}

const spawn = ($: Engine) =>
  $.agent.spawn({
    tool_use_id: 'tu-1',
    prompt: 'find auth code',
    description: 'find auth code',
    subagentType: 'Explore',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'claude-opus-5-5',
    background: true,
    fork: false,
  })

test('draws the main fill, cost, limits and one row per subagent', async ($, on) => {
  const toasts: string[] = []
  await boot($, on, toasts, 62)
  await spawn($)
  await step($, undefined, 'claude-opus-5-5')
  await step($, 'agent-1', 'claude-haiku-4-5')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'context-bar', surface, ...BAND })
    expect(await ui.find({ type: 'Text', text: /62%/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /\$1\.42/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /5h 34%/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Explore.*31k ctx/ })).toBeDefined()

    await ui.press({ key: 'detail' })
    expect(await ui.find({ type: 'Text', text: /31k ctx/ })).toBeUndefined()
    await ui.press({ key: 'detail' })
    await ui.unmount()
  }
  expect(toasts).toHaveLength(0)
})

test('warns once when the main context passes 80%', async ($, on) => {
  const toasts: string[] = []
  await boot($, on, toasts, 86)
  await step($, undefined, 'claude-opus-5-5')
  await step($, undefined, 'claude-opus-5-5')
  expect(toasts).toHaveLength(1)
  expect(toasts[0]).toMatch(/86%/)
})

test('yields the band to a survey', async ($, on) => {
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return h(Text, {}, 'engine band') as RenderElement
  })
  await boot($, on, [], 50)
  await step($, undefined, 'claude-opus-5-5')
  const ui = await $.ui.mount({ plugin: 'context-bar', surface: 'terminal', ...BAND, props: { ...BAND.props, hasSurvey: true } })
  expect(await ui.find({ type: 'Text', text: /50%/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'engine band' })).toBeDefined()
})
