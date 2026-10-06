export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 100_000 ? 0 : 1)}k`
  return String(Math.round(n))
}

// 'claude-opus-5-5' -> 'opus-5.5', 'claude-haiku-4-5-20251001' -> 'haiku-4.5'
export function shortModel(model: string): string {
  const bare = model.replace(/^claude-/, '').replace(/-\d{8}$/, '').replace(/\[.*\]$/, '')
  const match = /^([a-z]+)-(\d+)-(\d+)$/.exec(bare)
  return match ? `${match[1]}-${match[2]}.${match[3]}` : bare
}

// A subagent's window is not reported, so read it off the model id.
export function windowFor(model: string, mainWindow: number): number {
  if (/\[1m\]|-1m\b/i.test(model)) return 1_000_000
  return Math.min(mainWindow, 200_000) || 200_000
}

export function fillColor(percent: number): string {
  if (percent >= 85) return 'error'
  if (percent >= 60) return 'warning'
  return 'success'
}

export const AGENT_COLORS = ['#8abeb7', '#9575cd', '#81a2be', '#b5bd68', '#f0c674', '#de935f', '#cc6666']

export function bar(fraction: number, width: number): { filled: string; empty: string } {
  const cells = Math.max(0, Math.min(width, Math.round(fraction * width)))
  return { filled: '█'.repeat(cells), empty: '░'.repeat(Math.max(0, width - cells)) }
}

export function rateLabel(kind: string): string {
  if (kind === 'five_hour') return '5h'
  if (kind === 'seven_day') return '7d'
  return kind.replace(/_/g, ' ')
}
