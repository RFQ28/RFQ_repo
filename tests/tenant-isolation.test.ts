import { describe, expect, it } from 'vitest'
import type { AdminClient } from '@/lib/supabase/admin'
import { tenantDb } from '@/lib/supabase/tenant'

/**
 * The service-role client bypasses RLS, so `tenantDb` is the only thing keeping
 * background work inside one distributor. These tests record what it sends to
 * PostgREST: a read with no tenant filter, or a write with the wrong tenant
 * stamped on it, is the leak the PRD says must fail loudly (s7).
 */

type Recorded = {
  table: string
  method: string
  filters: [string, unknown][]
  payload?: unknown
}

function fakeClient() {
  const calls: Recorded[] = []

  function filterBuilder(record: Recorded) {
    const builder = {
      eq(column: string, value: unknown) {
        record.filters.push([column, value])
        return builder
      },
      neq(column: string, value: unknown) {
        record.filters.push([column, value])
        return builder
      },
      select() {
        return builder
      },
      order() {
        return builder
      },
      single() {
        return builder
      },
    }
    return builder
  }

  const client = {
    from(table: string) {
      return {
        select(columns?: string) {
          const record: Recorded = { table, method: 'select', filters: [], payload: columns }
          calls.push(record)
          return filterBuilder(record)
        },
        insert(payload: unknown) {
          const record: Recorded = { table, method: 'insert', filters: [], payload }
          calls.push(record)
          return filterBuilder(record)
        },
        upsert(payload: unknown) {
          const record: Recorded = { table, method: 'upsert', filters: [], payload }
          calls.push(record)
          return filterBuilder(record)
        },
        update(payload: unknown) {
          const record: Recorded = { table, method: 'update', filters: [], payload }
          calls.push(record)
          return filterBuilder(record)
        },
        delete() {
          const record: Recorded = { table, method: 'delete', filters: [] }
          calls.push(record)
          return filterBuilder(record)
        },
      }
    },
    storage: {} as never,
    rpc() {
      return Promise.resolve({ data: null, error: null })
    },
  }

  return { client: client as unknown as AdminClient, calls }
}

const TENANT_A = '11111111-1111-4111-8111-111111111111'
const TENANT_B = '22222222-2222-4222-8222-222222222222'

function tenantFilter(call: Recorded) {
  return call.filters.find(([column]) => column === 'tenant_id')
}

describe('tenantDb', () => {
  it('rejects anything that is not a tenant id', () => {
    expect(() => tenantDb('')).toThrow(/not a tenant id/)
    expect(() => tenantDb('all')).toThrow(/not a tenant id/)
    expect(() => tenantDb("' or 1=1 --")).toThrow(/not a tenant id/)
  })

  it('filters every read on tenant_id', () => {
    const { client, calls } = fakeClient()
    const db = tenantDb(TENANT_A, client)

    db.from('products').select('id, sku')
    db.from('quote_lines').select('*')
    db.from('corrections').select('id')

    expect(calls).toHaveLength(3)
    for (const call of calls) {
      expect(tenantFilter(call)).toEqual(['tenant_id', TENANT_A])
    }
  })

  it('filters updates and deletes too', () => {
    const { client, calls } = fakeClient()
    const db = tenantDb(TENANT_A, client)

    db.from('rfqs').update({ status: 'quoted' })
    db.from('quote_lines').delete()

    expect(tenantFilter(calls[0])).toEqual(['tenant_id', TENANT_A])
    expect(tenantFilter(calls[1])).toEqual(['tenant_id', TENANT_A])
  })

  it('stamps tenant_id onto inserts, including arrays', () => {
    const { client, calls } = fakeClient()
    const db = tenantDb(TENANT_A, client)

    db.from('products').insert({ sku: 'A1', description: 'Widget' })
    db.from('products').insert([
      { sku: 'A2', description: 'Gadget' },
      { sku: 'A3', description: 'Doodad' },
    ])

    expect(calls[0].payload).toEqual({ sku: 'A1', description: 'Widget', tenant_id: TENANT_A })
    expect(calls[1].payload).toEqual([
      { sku: 'A2', description: 'Gadget', tenant_id: TENANT_A },
      { sku: 'A3', description: 'Doodad', tenant_id: TENANT_A },
    ])
  })

  it('overwrites a tenant_id a caller tried to supply', () => {
    const { client, calls } = fakeClient()
    const db = tenantDb(TENANT_A, client)

    // Whether this arrives from a bug or from user input, the pinned tenant wins.
    db.from('products').insert({ sku: 'A1', description: 'Widget', tenant_id: TENANT_B } as never)

    expect(calls[0].payload).toMatchObject({ tenant_id: TENANT_A })
  })

  it('keeps two handles independent', () => {
    const { client, calls } = fakeClient()
    const a = tenantDb(TENANT_A, client)
    const b = tenantDb(TENANT_B, client)

    a.from('products').select('id')
    b.from('products').select('id')

    expect(tenantFilter(calls[0])).toEqual(['tenant_id', TENANT_A])
    expect(tenantFilter(calls[1])).toEqual(['tenant_id', TENANT_B])
  })

  it('scopes storage paths under the tenant', () => {
    const db = tenantDb(TENANT_A, fakeClient().client)
    expect(db.path('imports', 'abc', 'catalogue.csv')).toBe(`${TENANT_A}/imports/abc/catalogue.csv`)
  })

  it('stamps the audit trail as well', async () => {
    const { client, calls } = fakeClient()
    const db = tenantDb(TENANT_A, client)

    await db.log({ action: 'test.ran', entityType: 'test' })

    expect(calls[0].table).toBe('activity_log')
    expect(calls[0].payload).toMatchObject({ tenant_id: TENANT_A, action: 'test.ran', actor_kind: 'system' })
  })
})
