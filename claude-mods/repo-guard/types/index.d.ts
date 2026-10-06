/** Code files edited since the last passing `npm run check`. */
export type UncheckedFiles = string[]

declare module 'claude-code' {
  interface PluginState {
    'repo-guard': { unchecked: UncheckedFiles }
  }
}
