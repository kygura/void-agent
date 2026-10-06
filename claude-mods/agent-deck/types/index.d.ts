export type AgentStatus = 'running' | 'idle' | 'done' | 'failed' | 'aborted'

export type AgentRow = {
  /** 'main' for the main loop, the agent id otherwise. */
  id: string
  label: string
  type: string
  parentId?: string
  model?: string
  effort?: string
  status: AgentStatus
  steps: number
  toolCalls: number
  /** The tool running now, if any. */
  tool?: string
  /** Input tokens of the last request: the loop's current context. */
  contextTokens: number
  /** Output tokens summed over every request of the loop. */
  outputTokens: number
  startedAt: number
  endedAt?: number
}

export type TaskStatus = 'pending' | 'in_progress' | 'completed'

export type TaskItem = {
  id: string
  subject: string
  status: TaskStatus
  activeForm?: string
  /** The loop that last touched it. */
  agentId: string
}

declare module 'claude-code' {
  interface PluginState {
    'agent-deck': {
      agents: Record<string, AgentRow>
      tasks: TaskItem[]
      isCompact: boolean
      now: number
    }
  }
}
