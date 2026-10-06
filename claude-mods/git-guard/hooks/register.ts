import type { Register } from 'claude-code'

import { classify } from './rules'

export const register: Register = (on, options) => {
  const rules = { allowForceWithLease: options.allowForceWithLease !== false }

  on('tool.call', { tool: 'Bash' }, ($, e, next) => {
    const reason = classify(e.command, rules)
    if (reason === undefined) return next(e)

    $.ui.toast(`git-guard refused: ${e.command.slice(0, 60)}`)
    return { deny: `git-guard: ${reason}` }
  }).catch(($, e, next) =>
    next.called ? next(e) : { deny: 'git-guard: the guard failed, so the command was held back.' },
  )
}
