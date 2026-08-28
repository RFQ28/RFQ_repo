import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Loads .env.local into process.env for the integration suite.
 *
 * The unit suite does not need this — it never touches a network — but the
 * integration tests run against the real project, using the same credentials
 * the application does.
 */
try {
  const file = readFileSync(resolve(process.cwd(), '.env.local'), 'utf8')
  for (const line of file.split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/)
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].trim()
  }
} catch {
  // Missing .env.local is fine; the tests skip themselves when it is absent.
}
