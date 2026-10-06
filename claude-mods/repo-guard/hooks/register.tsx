import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { UncheckedFiles } from '../types'

const unchecked = atom({ plugin: 'repo-guard', key: 'unchecked' } as const, [])

/** AGENTS.md rules a shell command may break, each with the reason given back to the model. */
export const RULES: { pattern: RegExp; reason: string }[] = [
  { pattern: /\bgit\s+add\s+(-A\b|--all\b|\.(\s|$))/, reason: 'git add -A / git add . sweeps up other agents\' work. Stage your own files by path.' },
  { pattern: /\bgit\s+reset\s+.*--hard\b/, reason: 'git reset --hard destroys uncommitted changes.' },
  { pattern: /\bgit\s+checkout\s+(--\s+)?\.(\s|$)/, reason: 'git checkout . destroys uncommitted changes.' },
  { pattern: /\bgit\s+clean\s+-\w*f/, reason: 'git clean -f deletes untracked files.' },
  { pattern: /\bgit\s+stash(?!\s+(list|show)\b)/, reason: 'git stash stashes every agent\'s changes.' },
  { pattern: /\bgit\s+commit\b.*--no-verify\b/, reason: 'git commit --no-verify bypasses required checks.' },
  { pattern: /\bgit\s+push\b.*(\s-f\b|--force\b)/, reason: 'Never force push.' },
  { pattern: /\bnpm\s+run\s+(dev|build)\b/, reason: 'npm run dev / npm run build are not to be run by agents.' },
  { pattern: /\bnpm\s+(run\s+)?test\b/, reason: 'npm test is not to be run; run one test file with npx tsx ../../node_modules/vitest/dist/cli.js --run <file> from the package root.' },
]

/** The command with quoted strings and heredoc bodies blanked, so a commit message cannot trip a rule. */
export const stripQuoted = (command: string) =>
  command
    .replace(/<<-?\s*'?(\w+)'?[\s\S]*?\n\1\b/g, '')
    .replace(/'[^']*'/g, "''")
    .replace(/"(?:\\.|[^"\\])*"/g, '""')

export const brokenRule = (command: string) => {
  const bare = stripQuoted(command)
  return RULES.find(r => r.pattern.test(bare))
}

export const isCodeFile = (path: string) => /\.(ts|tsx|js|mjs|cjs|json)$/.test(path) && !/(^|\/)(CHANGELOG|README)\b/.test(path)

async function track($: EngineInterface, path: string) {
  if (!isCodeFile(path)) return
  const list = await update($, unchecked, (l: UncheckedFiles) => (l.includes(path) ? l : [...l, path]))
  $.ui.status(`check pending · ${list.length} files`)
}

export const register: Register = on => {
  let isActive = false
  let hasCheck = false

  on('session.start', async ($, e, next) => {
    const ran = await next(e)
    isActive = await $.fs.exists(`${ran.cwd}/AGENTS.md`)
    if (isActive && (await $.fs.exists(`${ran.cwd}/package.json`))) {
      const pkg = await $.fs.read(`${ran.cwd}/package.json`)
      hasCheck = /"check"\s*:/.test(pkg)
    }
    const pending = await read($, unchecked)
    $.ui.status(isActive && pending.length > 0 ? `check pending · ${pending.length} files` : undefined)
    return ran
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (!isActive) return next(e)
    const rule = brokenRule(e.command)
    if (rule) return { deny: `repo-guard: ${rule.reason} (AGENTS.md)` }

    const bare = stripQuoted(e.command)
    if (hasCheck && /\bgit\s+commit\b/.test(bare)) {
      const pending = await read($, unchecked)
      if (pending.length > 0) {
        return {
          deny: `repo-guard: ${pending.length} code file(s) changed since the last passing npm run check (${pending.slice(0, 3).join(', ')}${pending.length > 3 ? ', ...' : ''}). Run npm run check and fix every error first.`,
        }
      }
    }

    const ran = await next(e)
    if (hasCheck && /\bnpm\s+run\s+check\b/.test(bare) && ran.deny === undefined && !ran.isError) {
      await update($, unchecked, () => [])
      $.ui.status(undefined)
    }
    return ran
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'repo-guard: its guard failed; retry the command.' }))


  on('tool.call', { tool: 'Edit' }, async ($, e, next) => {
    const ran = await next(e)
    if (isActive && ran.deny === undefined && !ran.isError) await track($, e.file_path)
    return ran
  })

  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    const ran = await next(e)
    if (isActive && ran.deny === undefined && !ran.isError) await track($, e.file_path)
    return ran
  })
}
