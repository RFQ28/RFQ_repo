import { z } from 'zod'

/**
 * Env is validated once, at first access, and split in two so a server-only
 * secret can never be reached from a client bundle: `serverEnv()` throws
 * outright if it is called in the browser.
 */

const clientSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
  NEXT_PUBLIC_APP_URL: z.string().url().default('http://localhost:3000'),
})

const serverSchema = z.object({
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  TOKEN_ENCRYPTION_KEY: z.string().min(1).optional(),
  WORKER_SECRET: z.string().min(1).optional(),
  MS_CLIENT_ID: z.string().optional(),
  MS_CLIENT_SECRET: z.string().optional(),
  MS_REDIRECT_URI: z.string().optional(),
  GRAPH_WEBHOOK_CLIENT_STATE: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  EMBEDDING_API_KEY: z.string().optional(),
})

export type ClientEnv = z.infer<typeof clientSchema>
export type ServerEnv = z.infer<typeof serverSchema>

let clientCache: ClientEnv | null = null
let serverCache: ServerEnv | null = null

function fail(scope: string, error: z.ZodError): never {
  const lines = error.issues.map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
  throw new Error(`Invalid ${scope} environment:\n${lines.join('\n')}\n\nSee .env.example.`)
}

export function clientEnv(): ClientEnv {
  if (clientCache) return clientCache
  // Next inlines process.env.NEXT_PUBLIC_* at build time only for literal
  // member expressions, so each one is read out by name rather than in a loop.
  const parsed = clientSchema.safeParse({
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
  })
  if (!parsed.success) fail('client', parsed.error)
  clientCache = parsed.data
  return clientCache
}

export function serverEnv(): ServerEnv {
  if (typeof window !== 'undefined') {
    throw new Error('serverEnv() was called in the browser')
  }
  if (serverCache) return serverCache
  const parsed = serverSchema.safeParse(process.env)
  if (!parsed.success) fail('server', parsed.error)
  serverCache = parsed.data
  return serverCache
}
