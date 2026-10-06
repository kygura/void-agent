export type LoopUsage = {
  /** 'main' for the main loop, the agent id otherwise. */
  id: string
  label: string
  model?: string
  /** Input tokens of the loop's last request: its context fill now. */
  contextTokens: number
  /** Output tokens summed over the loop. */
  outputTokens: number
  isLive: boolean
  order: number
}

declare module 'claude-code' {
  interface PluginState {
    'context-bar': {
      loops: Record<string, LoopUsage>
      isHidden: boolean
      isDetailed: boolean
      warnedAt: number
    }
  }
}
