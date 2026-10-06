import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const BASH_OK = { stdout: '', stderr: '', interrupted: false }

const boot = async ($: Engine, on: On, ran: string[]) => {
  on('session.start', () => ({ cwd: '/repo' }))
  on('fs.exists', () => ({ value: true }))
  on('fs.read', () => ({ value: '{ "scripts": { "check": "biome check && tsgo --noEmit" } }' }))
  on('tool.call', { tool: 'Bash' }, (_$, e) => {
    ran.push(e.command)
    return { result: BASH_OK }
  })
  on('tool.call', { tool: 'Edit' }, () => ({
    result: { filePath: '/repo/a.ts', oldString: 'a', newString: 'b', originalFile: 'a', structuredPatch: [], userModified: false, replaceAll: false },
  }))
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
}

test('refuses the git and npm commands AGENTS.md forbids', async ($, on) => {
  const ran: string[] = []
  await boot($, on, ran)
  for (const command of [
    'git add -A',
    'cd packages/ai && git add .',
    'git reset --hard HEAD~1',
    'git stash',
    'git commit --no-verify -m x',
    'git push --force origin main',
    'npm run build',
    'npm test',
    'git clean -fd',
  ]) {
    const out = await $.tool.call({ tool: 'Bash', command })
    expect(out.deny ?? out.text ?? '', command).toMatch(/repo-guard/)
  }
  expect(ran).toHaveLength(0)
})

test('lets safe commands through, quoted text included', async ($, on) => {
  const ran: string[] = []
  await boot($, on, ran)
  for (const command of ['git add packages/ai/src/x.ts', 'git stash list', 'git status', 'echo "never git add -A"']) {
    const out = await $.tool.call({ tool: 'Bash', command })
    expect(out.deny).toBeUndefined()
  }
  expect(ran).toHaveLength(4)
})

test('blocks a commit after a code edit until npm run check passes', async ($, on) => {
  const ran: string[] = []
  await boot($, on, ran)
  await $.tool.call({ tool: 'Edit', file_path: '/repo/a.ts', old_string: 'a', new_string: 'b' })

  const blocked = await $.tool.call({ tool: 'Bash', command: 'git commit -m "fix: thing"' })
  expect(blocked.deny ?? blocked.text ?? '').toMatch(/npm run check/)

  await $.tool.call({ tool: 'Bash', command: 'npm run check' })
  const passed = await $.tool.call({ tool: 'Bash', command: 'git commit -m "fix: thing"' })
  expect(passed.deny).toBeUndefined()
  expect(ran).toEqual(['npm run check', 'git commit -m "fix: thing"'])
})
