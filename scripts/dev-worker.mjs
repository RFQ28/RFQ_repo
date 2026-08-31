/**
 * Stands in for the scheduler while developing.
 *
 * /api/jobs/run drains a batch and returns; in production something external
 * calls it on an interval. Nothing does that on a laptop, so an RFQ arrives,
 * a job is queued, and then nothing visibly happens — which reads as the
 * intake being broken when it is working exactly as designed.
 *
 *   node scripts/dev-worker.mjs
 */
import { readFileSync } from 'node:fs'

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8').split(/\r?\n/)
    .map((l) => l.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map((m) => [m[1], m[2].trim()]),
)

const INTERVAL = Number(process.env.INTERVAL_MS ?? 4000)
const base = 'http://localhost:3001'

console.log(`draining ${base}/api/jobs/run every ${INTERVAL}ms — ctrl-c to stop`)

for (;;) {
  try {
    const r = await fetch(`${base}/api/jobs/run`, {
      method: 'POST',
      headers: { authorization: `Bearer ${env.WORKER_SECRET}`, 'x-worker-id': 'dev-worker' },
    })
    const result = await r.json()
    // Only say something when there was something to do.
    if (result.claimed > 0) {
      const at = new Date().toLocaleTimeString('en-US')
      console.log(`${at}  claimed ${result.claimed}  succeeded ${result.succeeded}  failed ${result.failed}  dead ${result.dead}`)
    }
    if (!r.ok) console.log(`worker endpoint ${r.status}: ${JSON.stringify(result)}`)
  } catch (error) {
    console.log(`worker unreachable: ${String(error).slice(0, 100)}`)
  }
  await new Promise((resolve) => setTimeout(resolve, INTERVAL))
}
