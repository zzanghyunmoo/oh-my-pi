import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const canonicalSkill = 'skills/workspace-integrations/SKILL.md'
const shimSkills = [
  '.agents/skills/workspace-integrations/SKILL.md',
  '.claude/skills/workspace-integrations/SKILL.md'
]

function readFrontmatter(skillPath) {
  const content = readFileSync(join(repoRoot, skillPath), 'utf8')
  const match = content.match(/^---\n([\s\S]*?)\n---/)
  assert.ok(match, `${skillPath} must start with YAML frontmatter`)

  return Object.fromEntries(
    match[1]
      .split('\n')
      .map((line) => line.match(/^([^:]+):\s*(.*)$/))
      .filter(Boolean)
      .map(([, key, value]) => [key.trim(), value.trim()])
  )
}

// Regression: cross-agent skill discovery shims must point back to the canonical skill.
assert.ok(existsSync(join(repoRoot, canonicalSkill)), 'canonical skill must exist')

const canonicalFrontmatter = readFrontmatter(canonicalSkill)
assert.equal(canonicalFrontmatter.name, 'workspace-integrations')
assert.ok(canonicalFrontmatter.description, 'canonical skill must have a description')

for (const shimSkill of shimSkills) {
  assert.ok(existsSync(join(repoRoot, shimSkill)), `${shimSkill} must exist`)

  const shimFrontmatter = readFrontmatter(shimSkill)
  assert.equal(shimFrontmatter.name, canonicalFrontmatter.name, `${shimSkill} name must match canonical skill`)
  assert.equal(
    shimFrontmatter.description,
    canonicalFrontmatter.description,
    `${shimSkill} description must match canonical skill`
  )

  const shimContent = readFileSync(join(repoRoot, shimSkill), 'utf8')
  const relativeCanonicalPath = '../../../skills/workspace-integrations/SKILL.md'
  assert.match(shimContent, /\.\.\/\.\.\/\.\.\/skills\/workspace-integrations\/SKILL\.md/)
  assert.ok(
    existsSync(join(repoRoot, dirname(shimSkill), relativeCanonicalPath)),
    `${shimSkill} relative canonical path must resolve`
  )
}

console.log('Skill validation passed')
