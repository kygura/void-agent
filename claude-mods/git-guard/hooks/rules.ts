// Pure classification of shell commands against the parallel-agent git rules.
// Returns the reason a command is refused, or undefined when it may run.

export type RuleOptions = { allowForceWithLease: boolean }

const SEPARATORS = /&&|\|\||;|\||\n/

// Global git options that take a value as the next word (`git -C dir status`).
const OPTIONS_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace'])

export function tokenize(segment: string): string[] {
  const words: string[] = []
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g
  for (const match of segment.matchAll(pattern)) {
    words.push(match[1] ?? match[2] ?? match[3] ?? '')
  }
  return words
}

function gitArgs(words: string[]): string[] | undefined {
  // Skip env assignments and wrappers in front of git (`FOO=1 git`, `command git`).
  let index = 0
  while (index < words.length) {
    const word = words[index] ?? ''
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word) || word === 'command' || word === 'sudo') {
      index += 1
      continue
    }
    break
  }
  const head = words[index]
  if (head === undefined || !/(^|\/)git$/.test(head)) return undefined

  const rest = words.slice(index + 1)
  let cursor = 0
  while (cursor < rest.length && (rest[cursor] ?? '').startsWith('-')) {
    cursor += OPTIONS_WITH_VALUE.has(rest[cursor] ?? '') ? 2 : 1
  }
  return rest.slice(cursor)
}

function hasShortFlag(args: string[], flag: string): boolean {
  return args.some(arg => /^-[A-Za-z]+$/.test(arg) && arg.includes(flag))
}

function classifySegment(segment: string, options: RuleOptions): string | undefined {
  const args = gitArgs(tokenize(segment.trim()))
  if (args === undefined || args.length === 0) return undefined
  const [sub, ...rest] = args

  switch (sub) {
    case 'reset':
      if (rest.includes('--hard')) {
        return 'git reset --hard destroys uncommitted changes, other agents\' included. Revert specific files with `git restore <path>` instead.'
      }
      return undefined
    case 'checkout':
      if (rest.includes('.') && !rest.some(arg => arg !== '.' && arg !== '--')) {
        return 'git checkout . throws away every uncommitted change in the tree. Restore only the files you changed: `git checkout -- <path>`.'
      }
      return undefined
    case 'restore':
      if (rest.includes('.') && !rest.includes('--staged')) {
        return 'git restore . throws away every uncommitted change in the tree. Name the files you changed.'
      }
      return undefined
    case 'clean':
      if (hasShortFlag(rest, 'f') || rest.includes('--force')) {
        return 'git clean -f deletes untracked files, which may be another agent\'s new work. Delete your own files by path.'
      }
      return undefined
    case 'stash': {
      const action = rest[0]
      if (action === 'list' || action === 'show') return undefined
      return 'git stash sweeps up every agent\'s uncommitted changes. Commit your own files by path instead.'
    }
    case 'add':
      if (rest.includes('-A') || rest.includes('--all') || rest.includes('.') || rest.includes('-u') || rest.includes('--update')) {
        return 'git add -A / git add . stages other agents\' work. Stage only the files you changed: `git add <path> ...`.'
      }
      return undefined
    case 'commit':
    case 'push':
    case 'merge':
    case 'rebase':
      if (rest.includes('--no-verify') || (sub === 'commit' && hasShortFlag(rest, 'n'))) {
        return `git ${sub} --no-verify bypasses the required checks. Fix what the hook reports instead.`
      }
      if (sub === 'push') {
        const forced = rest.includes('--force') || hasShortFlag(rest, 'f') || rest.some(arg => /^\+[^+]/.test(arg))
        const leased = rest.some(arg => arg.startsWith('--force-with-lease'))
        if (forced) return 'git push --force rewrites shared history. Pull --rebase and push normally.'
        if (leased && !options.allowForceWithLease) {
          return 'git push --force-with-lease is turned off by git-guard\'s settings.'
        }
      }
      return undefined
    default:
      return undefined
  }
}

export function classify(command: string, options: RuleOptions): string | undefined {
  for (const segment of command.split(SEPARATORS)) {
    const reason = classifySegment(segment, options)
    if (reason !== undefined) return reason
  }
  return undefined
}
