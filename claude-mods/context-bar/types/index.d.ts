export type RateLimit = { kind: string; percentUsed: number; resetsAt?: string }

export type Measure = {
  tokens?: number
  window: number
  percent?: number
  costUsd?: number
  rateLimits: RateLimit[]
}

export type AgentUsage = {
  id: string
  label: string
  model: string
  effort?: string
  contextTokens: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  steps: number
  isDone: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'context-bar': {
      measure: Measure | null
      agents: AgentUsage[]
      isExpanded: boolean
    }
  }
}
