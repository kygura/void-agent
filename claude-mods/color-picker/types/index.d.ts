export type Swatch = { hex: string; name?: string }

declare module 'claude-code' {
  interface PluginState {
    'color-picker': {
      current: string
      palette: Swatch[]
      paletteTitle: string
      history: string[]
    }
  }
}
