// Box-and-arrow chains: "Parse -> Plan -> Run; Run -> Review".
// Each ';'-separated chain is one row of boxes joined by arrows; a '|' inside
// a step stacks alternatives in one column ("Run -> Pass | Fail").

const width = (text: string): number => [...text].length

function boxLines(labels: string[]): string[] {
  const inner = Math.max(...labels.map(width)) + 2
  const lines = [`┌${'─'.repeat(inner)}┐`]
  labels.forEach((label, index) => {
    if (index > 0) lines.push(`├${'─'.repeat(inner)}┤`)
    lines.push(`│ ${label}${' '.repeat(inner - 2 - width(label))} │`)
  })
  lines.push(`└${'─'.repeat(inner)}┘`)
  return lines
}

function chain(text: string): string {
  const steps = text
    .split(/\s*(?:->|→)\s*/)
    .map(step => step.trim())
    .filter(Boolean)
  if (steps.length === 0) return ''
  const boxes = steps.map(step => boxLines(step.split(/\s*\|\s*/).filter(Boolean)))
  const height = Math.max(...boxes.map(box => box.length))
  const arrowRow = 1
  const rows: string[] = Array.from({ length: height }, () => '')
  boxes.forEach((box, index) => {
    const boxWidth = width(box[0] ?? '')
    for (let row = 0; row < height; row += 1) {
      const isLast = index === boxes.length - 1
      const joint = isLast ? '' : row === arrowRow ? '───▶' : '    '
      rows[row] = `${rows[row] ?? ''}${box[row] ?? ' '.repeat(boxWidth)}${joint}`
    }
  })
  return rows.map(row => row.replace(/\s+$/, '')).join('\n')
}

export function flow(text: string): string {
  return text
    .split(/\s*;\s*|\n/)
    .filter(part => part.trim() !== '')
    .map(chain)
    .join('\n\n')
}
