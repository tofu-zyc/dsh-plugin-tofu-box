import { createRequire } from 'node:module'
import { join } from 'node:path'

/** The 0.1.7-alpha.2 deployment supplied only to this isolated test process. */
export function hostDeploymentRoot() {
  const root = process.env.DSH_TEST_DEPLOY_ROOT
  if (!root) return undefined
  const anchor = join(root, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  try {
    createRequire(anchor).resolve('@deepseek-ai/dsh-session-title-llm')
  } catch {
    return undefined
  }
  return anchor
}

const anchor = hostDeploymentRoot()
if (anchor) process.argv[1] = anchor

export function requireHostHelper() {
  if (!anchor) throw new Error('set DSH_TEST_DEPLOY_ROOT to an isolated 0.1.7-alpha.2 deployment containing the title helper')
}
