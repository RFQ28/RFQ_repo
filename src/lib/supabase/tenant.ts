import 'server-only'

import { adminClient, type AdminClient } from './admin'
import type { TenantScopedTable } from '@/lib/db/types'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * A service-role handle pinned to one tenant.
 *
 * Background work bypasses RLS, so the isolation guarantee has to come from
 * somewhere else. Here it comes from construction: `from()` hands back the
 * ordinary Supabase query builder wrapped in a proxy that filters every read,
 * update and delete on tenant_id and stamps it onto every insert. There is no
 * path through this object that omits either, and a job that genuinely needs
 * the unpinned client has to say so out loud by calling `adminClient()`.
 *
 * `tenant_id` is optional on every Insert type for exactly this reason -- it is
 * not the caller's to choose (see the `Defaulted` note in lib/db/types.ts).
 */
export type TenantDb = ReturnType<typeof tenantDb>

export function tenantDb(tenantId: string, client?: AdminClient) {
  // Checked before the client is built, so a bad tenant id fails on its own
  // terms rather than as a missing-environment error.
  if (!UUID_RE.test(tenantId)) {
    throw new Error(`tenantDb: "${tenantId}" is not a tenant id`)
  }

  const db = client ?? adminClient()

  const stamp = (values: unknown): unknown =>
    Array.isArray(values)
      ? values.map((v) => ({ ...(v as object), tenant_id: tenantId }))
      : { ...(values as object), tenant_id: tenantId }

  function from<T extends TenantScopedTable>(table: T) {
    const builder = db.from(table)

    const proxy = new Proxy(builder, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver)
        if (typeof value !== 'function') return value
        const method = value as (...args: unknown[]) => unknown

        switch (property) {
          case 'select':
          case 'update':
          case 'delete':
            return (...args: unknown[]) => {
              const filter = method.apply(target, args) as {
                eq: (column: string, value: string) => unknown
              }
              return filter.eq('tenant_id', tenantId)
            }
          case 'insert':
          case 'upsert':
            return (values: unknown, ...rest: unknown[]) =>
              method.apply(target, [stamp(values), ...rest])
          default:
            return method.bind(target)
        }
      },
    })

    return proxy as typeof builder
  }

  return {
    tenantId,
    from,

    /** Tenant-scoped storage path: every object lives under <tenant_id>/... */
    path(...segments: string[]) {
      return [tenantId, ...segments].join('/')
    },

    storage: db.storage,

    rpc: db.rpc.bind(db),

    /**
     * Append to the audit trail (6.10, s9). Every automated action should leave
     * one of these behind.
     */
    async log(entry: {
      action: string
      entityType: string
      entityId?: string | null
      rfqId?: string | null
      quoteId?: string | null
      actorId?: string | null
      detail?: Record<string, unknown>
    }) {
      const { error } = await from('activity_log').insert({
        action: entry.action,
        entity_type: entry.entityType,
        entity_id: entry.entityId ?? null,
        rfq_id: entry.rfqId ?? null,
        quote_id: entry.quoteId ?? null,
        actor_id: entry.actorId ?? null,
        actor_kind: entry.actorId ? 'user' : 'system',
        detail: (entry.detail ?? null) as never,
      })
      // A dropped audit row must not take the operation down with it, but it
      // is never silent either.
      if (error) console.error('activity_log insert failed', { tenantId, entry, error })
    },
  }
}
