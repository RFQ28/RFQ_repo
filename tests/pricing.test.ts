import { describe, expect, it } from 'vitest'
import {
  applyGlobalMargin, extendedPrice, marginOf, priceFromMargin, priceLine, ruleApplies, selectRule,
  type ApplicableRule, type PricedProduct,
} from '@/lib/quote/pricing'

const product: PricedProduct = {
  id: 'p1',
  category: 'WIRE',
  manufacturer: 'Southwire',
  list_price: 100,
  cost: 55,
}

const CUSTOMER = 'c1'

function rule(over: Partial<ApplicableRule> & Pick<ApplicableRule, 'id' | 'scope' | 'method' | 'value'>): ApplicableRule {
  return {
    customer_id: null, product_id: null, category: null, manufacturer: null,
    contract_code: null, job_name: null, precedence: 0,
    effective_from: null, effective_to: null,
    ...over,
  }
}

const customerDiscount = rule({
  id: 'r-customer', scope: 'customer', method: 'discount_percent_off_list', value: 22,
  customer_id: CUSTOMER,
})

describe('ruleApplies', () => {
  const context = { customerId: CUSTOMER, jobName: null }

  it('matches a customer-level rule to its customer only', () => {
    expect(ruleApplies(customerDiscount, product, context)).toBe(true)
    expect(ruleApplies(customerDiscount, product, { customerId: 'other', jobName: null })).toBe(false)
  })

  it('requires the category to match on a category rule', () => {
    const r = rule({ id: 'r', scope: 'customer_category', method: 'discount_percent_off_list', value: 30, customer_id: CUSTOMER, category: 'WIRE' })
    expect(ruleApplies(r, product, context)).toBe(true)
    expect(ruleApplies(r, { ...product, category: 'BOXES' }, context)).toBe(false)
  })

  it('respects effective dates', () => {
    const expired = rule({ ...customerDiscount, id: 'r-old', effective_to: '2025-12-31' })
    const future = rule({ ...customerDiscount, id: 'r-new', effective_from: '2027-01-01' })
    const asOf = new Date('2026-06-15')

    expect(ruleApplies(expired, product, { ...context, asOf })).toBe(false)
    expect(ruleApplies(future, product, { ...context, asOf })).toBe(false)
    expect(ruleApplies(customerDiscount, product, { ...context, asOf })).toBe(true)
  })

  it('only applies a contract the customer is actually on', () => {
    const r = rule({ id: 'r-contract', scope: 'contract', method: 'fixed_price', value: 61, contract_code: 'SPA-1042' })
    expect(ruleApplies(r, product, context)).toBe(false)
    expect(ruleApplies(r, product, { ...context, contractCodes: ['SPA-1042'] })).toBe(true)
  })

  it('matches a job rule on the job name', () => {
    const r = rule({ id: 'r-job', scope: 'job', method: 'fixed_price', value: 58, job_name: 'Riverside Medical' })
    expect(ruleApplies(r, product, { customerId: CUSTOMER, jobName: 'riverside medical' })).toBe(true)
    expect(ruleApplies(r, product, { customerId: CUSTOMER, jobName: 'Other Job' })).toBe(false)
  })
})

describe('selectRule', () => {
  const context = { customerId: CUSTOMER, jobName: 'Riverside Medical', contractCodes: ['SPA-1042'] }

  const categoryRule = rule({ id: 'r-cat', scope: 'customer_category', method: 'discount_percent_off_list', value: 30, customer_id: CUSTOMER, category: 'WIRE' })
  const productRule = rule({ id: 'r-prod', scope: 'customer_product', method: 'fixed_price', value: 65, customer_id: CUSTOMER, product_id: 'p1' })
  const contractRule = rule({ id: 'r-con', scope: 'contract', method: 'fixed_price', value: 61, contract_code: 'SPA-1042' })
  const jobRule = rule({ id: 'r-job', scope: 'job', method: 'fixed_price', value: 58, job_name: 'Riverside Medical' })

  it('prefers the more specific rule', () => {
    expect(selectRule([customerDiscount, categoryRule], product, context)?.id).toBe('r-cat')
    expect(selectRule([customerDiscount, categoryRule, productRule], product, context)?.id).toBe('r-prod')
    expect(selectRule([contractRule, categoryRule], product, context)?.id).toBe('r-con')
  })

  it('lets a job price beat everything else', () => {
    const winner = selectRule([customerDiscount, categoryRule, productRule, contractRule, jobRule], product, context)
    expect(winner?.id).toBe('r-job')
  })

  it('lets an admin override the ordering with precedence', () => {
    const boosted = rule({ ...customerDiscount, id: 'r-boost', precedence: 100 })
    expect(selectRule([boosted, productRule, jobRule], product, context)?.id).toBe('r-boost')
  })

  it('returns null when nothing applies', () => {
    expect(selectRule([customerDiscount], product, { customerId: 'someone-else', jobName: null })).toBeNull()
  })
})

describe('priceLine', () => {
  const context = { customerId: CUSTOMER, jobName: null }

  it('applies a percentage off list', () => {
    const result = priceLine(product, [customerDiscount], context)
    expect(result.unitPrice).toBe(78)
    expect(result.priceSource).toBe('customer')
    expect(result.explanation).toBe('22% off list (this customer)')
    expect(result.priceMissing).toBe(false)
  })

  it('applies a multiplier', () => {
    const r = rule({ id: 'r', scope: 'customer', method: 'multiplier_on_list', value: 0.68, customer_id: CUSTOMER })
    expect(priceLine(product, [r], context).unitPrice).toBe(68)
  })

  it('applies a fixed price', () => {
    const r = rule({ id: 'r', scope: 'customer_product', method: 'fixed_price', value: 61.5, customer_id: CUSTOMER, product_id: 'p1' })
    expect(priceLine(product, [r], context).unitPrice).toBe(61.5)
  })

  it('applies cost plus', () => {
    const r = rule({ id: 'r', scope: 'customer', method: 'cost_plus_percent', value: 20, customer_id: CUSTOMER })
    expect(priceLine(product, [r], context).unitPrice).toBe(66)
  })

  it('falls back to list and says it is falling back', () => {
    const result = priceLine(product, [], context)
    expect(result.unitPrice).toBe(100)
    expect(result.priceSource).toBe('list_no_rule')
    expect(result.explanation).toBe('List price — no customer rule found')
    expect(result.flagReasons).toContain('list_price_no_rule')
  })

  it('reports a missing price rather than inventing one', () => {
    const result = priceLine({ ...product, list_price: null }, [], context)
    expect(result.unitPrice).toBeNull()
    expect(result.priceMissing).toBe(true)
    expect(result.flagReasons).toContain('price_missing')
  })

  it('reports a discount it cannot apply for want of a list price', () => {
    const result = priceLine({ ...product, list_price: null }, [customerDiscount], context)
    expect(result.unitPrice).toBeNull()
    expect(result.priceMissing).toBe(true)
    expect(result.explanation).toMatch(/no list price to apply it to/)
  })

  it('reports cost-plus it cannot apply for want of a cost', () => {
    const r = rule({ id: 'r', scope: 'customer', method: 'cost_plus_percent', value: 20, customer_id: CUSTOMER })
    const result = priceLine({ ...product, cost: null }, [r], context)
    expect(result.priceMissing).toBe(true)
    expect(result.explanation).toMatch(/no cost to apply it to/)
  })

  it('flags a price that lands below cost', () => {
    const r = rule({ id: 'r', scope: 'customer', method: 'fixed_price', value: 40, customer_id: CUSTOMER })
    expect(priceLine(product, [r], context).flagReasons).toContain('below_cost')
  })

  it('explains itself in words a rep would use', () => {
    const jobRule = rule({ id: 'r', scope: 'job', method: 'fixed_price', value: 58, job_name: 'Riverside' })
    const result = priceLine(product, [jobRule], { customerId: CUSTOMER, jobName: 'Riverside' })
    expect(result.explanation).toBe('$58 fixed price (job "Riverside")')
  })
})

describe('margin', () => {
  it('prices from a target margin', () => {
    expect(priceFromMargin(60, 25)).toBe(80)
    expect(priceFromMargin(55, 0)).toBe(55)
  })

  it('refuses a margin of 100% or more', () => {
    expect(priceFromMargin(60, 100)).toBeNull()
    expect(priceFromMargin(60, 120)).toBeNull()
  })

  it('reports the margin a price represents', () => {
    expect(marginOf(80, 60)).toBe(25)
    expect(marginOf(100, null)).toBeNull()
    expect(marginOf(null, 60)).toBeNull()
  })

  it('extends a line', () => {
    expect(extendedPrice(78, 500)).toBe(39000)
    expect(extendedPrice(null, 500)).toBeNull()
    expect(extendedPrice(78, null)).toBeNull()
  })

  it('skips locked lines and lines with no cost when a global margin is set', () => {
    const result = applyGlobalMargin(
      [
        { id: 'a', cost: 60, marginLocked: false },
        { id: 'b', cost: 60, marginLocked: true },
        { id: 'c', cost: null, marginLocked: false },
      ],
      25,
    )

    expect(result[0]).toEqual({ id: 'a', unitPrice: 80, skipped: null })
    expect(result[1]).toEqual({ id: 'b', unitPrice: null, skipped: 'locked' })
    expect(result[2]).toEqual({ id: 'c', unitPrice: null, skipped: 'no_cost' })
  })
})
