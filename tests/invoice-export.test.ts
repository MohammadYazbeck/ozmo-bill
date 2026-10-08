import { describe, expect, it } from 'vitest'
import { buildInvoiceExportRows, type InvoiceClient } from '@/app/invoice'

describe('invoice Excel balance', () => {
  it('subtracts a partial payment from the subscription invoice total', () => {
    const client: InvoiceClient = {
      name: 'Example client',
      package: 'Social Media',
      monthly: 450,
      due: 300,
      invoiceTotal: 450,
      invoicePaid: 150,
      invoiceDue: 300,
      invoiceLines: [{
        description: 'Social Media monthly subscription',
        quantity: 1,
        unitAmount: 450,
        total: 450,
      }],
    }

    const rows = buildInvoiceExportRows(client, new Date('2026-10-01T00:00:00'))

    expect(rows).toEqual([
      ['Social Media monthly subscription', 1, 450, 450],
      ['Payment received', 1, -150, -150],
    ])
    expect(rows.reduce((sum, row) => sum + (row[3] ?? 0), 0)).toBe(300)
  })
})
