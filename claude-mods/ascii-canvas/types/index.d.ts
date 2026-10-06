export type Frame = { title: string; art: string; origin: 'model' | 'banner' | 'flow' }

export type CanvasMode = 'canvas' | 'styles'

declare module 'claude-code' {
  interface PluginState {
    'ascii-canvas': {
      frames: Frame[]
      index: number
      mode: CanvasMode
    }
  }
}
