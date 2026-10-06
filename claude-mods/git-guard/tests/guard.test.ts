import { describe, expect, test } from 'claude-code/testing'

import { classify } from '../hooks/rules'

const on = { allowForceWithLease: true }
const off = { allowForceWithLease: false }

describe('classify', () => {
  test('refuses the forbidden operations', () => {
    for (const command of [
      'git reset --hard HEAD~1',
      'git checkout .',
      'git checkout -- .',
      'git clean -fd',
      'git clean --force',
      'git stash',
      'git stash push -m wip',
      'git add -A',
      'git add .',
      'git add --all',
      'git commit --no-verify -m x',
      'git commit -nm x',
      'git push --force',
      'git push -f origin main',
      'git push origin +main',
      'cd pkg && git add -A && git commit -m x',
      'git -C packages/ai reset --hard',
      'FOO=1 git stash',
    ]) {
      expect(classify(command, on)).toBeDefined()
    }
  })

  test('lets ordinary commands through', () => {
    for (const command of [
      'git status',
      'git add packages/ai/src/index.ts packages/ai/CHANGELOG.md',
      'git commit -m "fix(ai): add -A flag docs"',
      'git push -u origin feature',
      'git stash list',
      'git checkout -b feature',
      'git checkout -- src/a.ts',
      'git reset HEAD src/a.ts',
      'git clean -n',
      'echo "git reset --hard" > notes.txt',
      'npm run check',
    ]) {
      expect(classify(command, on)).toBeUndefined()
    }
  })

  test('force-with-lease follows the setting', () => {
    expect(classify('git push --force-with-lease', on)).toBeUndefined()
    expect(classify('git push --force-with-lease', off)).toBeDefined()
  })
})

test('denies a forbidden Bash call and passes a safe one', async ($, hooks) => {
  let ran = 0
  hooks('tool.call', { tool: 'Bash' }, () => {
    ran += 1
    return { result: { stdout: '', stderr: '', interrupted: false } }
  })

  const refused = await $.tool.call({ tool: 'Bash', command: 'git reset --hard' })
  expect(refused.isError ?? refused.deny !== undefined).toBe(true)
  expect(ran).toBe(0)

  await $.tool.call({ tool: 'Bash', command: 'git status' })
  expect(ran).toBe(1)
})
