export type AgentState = 'pending' | 'running' | 'waiting' | 'idle' | 'done' | 'failed' | 'killed'

export type AgentRow = {
  id: string
  label: string
  type: string
  parentId?: string
  model?: string
  effort?: string
  state: AgentState
  steps: number
  contextTokens: number
  outputTokens: number
  toolCount: number
  currentTool?: string
  lastTool?: string
  startedAt: number
  endedAt?: number
}

export type TaskState = 'pending' | 'in_progress' | 'completed'

export type TaskRow = {
  id: string
  subject: string
  activeForm?: string
  state: TaskState
  owner?: string
}

export type DeckView = 'all' | 'agents' | 'tasks'

declare module 'claude-code' {
  interface PluginState {
    'agent-deck': {
      agents: AgentRow[]
      tasks: TaskRow[]
      view: DeckView
      frame: number
    }
  }
}
