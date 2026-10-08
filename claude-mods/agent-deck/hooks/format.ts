import type { AgentRow, AgentState, TaskRow } from '../types'

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 100_000 ? 0 : 1)}k`
  return String(Math.round(n))
}

export function shortModel(model: string | undefined): string {
  if (model === undefined || model === '') return '…'
  const bare = model.replace(/^claude-/, '').replace(/-\d{8}$/, '').replace(/\[.*\]$/, '')
  const match = /^([a-z]+)-(\d+)-(\d+)$/.exec(bare)
  return match ? `${match[1]}-${match[2]}.${match[3]}` : bare
}

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, '0')}s`
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`
}

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

export function glyph(state: AgentState | TaskRow['state'], frame: number): { text: string; color: string } {
  switch (state) {
    case 'running':
    case 'in_progress':
      return { text: SPINNER[frame % SPINNER.length] ?? '•', color: 'claude' }
    case 'waiting':
      return { text: '◐', color: 'warning' }
    case 'idle':
      return { text: '◇', color: 'subtle' }
    case 'done':
    case 'completed':
      return { text: '✓', color: 'success' }
    case 'failed':
      return { text: '✗', color: 'error' }
    case 'killed':
      return { text: '⊘', color: 'inactive' }
    default:
      return { text: '○', color: 'inactive' }
  }
}

export function isLive(row: AgentRow): boolean {
  return row.state === 'running' || row.state === 'waiting' || row.state === 'pending'
}

// One line naming what a tool call is doing.
export function describeTool(tool: string, input: Record<string, unknown>): string {
  const pick = (key: string): string | undefined => {
    const value = input[key]
    return typeof value === 'string' ? value : undefined
  }
  const base = (path: string | undefined): string => (path ?? '').split('/').pop() ?? ''
  switch (tool) {
    case 'Bash':
      return `$ ${(pick('description') ?? pick('command') ?? '').split('\n')[0]}`
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'NotebookEdit':
      return `${tool} ${base(pick('file_path') ?? pick('notebook_path'))}`
    case 'Grep':
    case 'Glob':
      return `${tool} ${pick('pattern') ?? ''}`
    case 'Agent':
      return `Agent ${pick('description') ?? ''}`
    case 'WebFetch':
      return `Fetch ${pick('url') ?? ''}`
    case 'WebSearch':
      return `Search ${pick('query') ?? ''}`
    default:
      return tool.startsWith('mcp__') ? tool.split('__').slice(1).join(':') : tool
  }
}

// Agents in tree order: each parent followed by its children, depth alongside.
export function treeOrder(rows: readonly AgentRow[]): Array<{ row: AgentRow; depth: number; isLast: boolean }> {
  const ids = new Set(rows.map(row => row.id))
  const children = new Map<string, AgentRow[]>()
  const roots: AgentRow[] = []
  for (const row of rows) {
    const parent = row.parentId !== undefined && ids.has(row.parentId) ? row.parentId : undefined
    if (parent === undefined || row.id === parent) roots.push(row)
    else children.set(parent, [...(children.get(parent) ?? []), row])
  }
  const out: Array<{ row: AgentRow; depth: number; isLast: boolean }> = []
  const walk = (row: AgentRow, depth: number, isLast: boolean): void => {
    out.push({ row, depth, isLast })
    const kids = children.get(row.id) ?? []
    kids.forEach((kid, index) => walk(kid, depth + 1, index === kids.length - 1))
  }
  roots.forEach((row, index) => walk(row, 0, index === roots.length - 1))
  return out
}
