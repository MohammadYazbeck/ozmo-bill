import { describe, expect, it } from 'vitest'
import {
  allocatePaymentFifo,
  decimalToUnits,
  receivableStatus,
  unitsToDecimal,
  usdEquivalent,
} from '@/lib/finance/accounting'

describe('accounting money helpers', () => {
  it('round-trips canonical fixed-scale values without floating-point arithmetic', () => {
    expect(decimalToUnits('12.3456')).toBe(123_456n)
    expect(unitsToDecimal(123_400n)).toBe('12.34')
  })

  it('keeps USD unchanged and snapshots SYP conversion to six places', () => {
    expect(usdEquivalent('19.99', 'USD', '12000')).toBe('19.99')
    expect(usdEquivalent('1000000', 'SYP', '12000')).toBe('83.3333')
  })

  it('allocates customer payments oldest-first and preserves overpayment credit', () => {
    expect(allocatePaymentFifo('175', [
      { id: 'old', due: '100' },
      { id: 'new', due: '50' },
    ])).toEqual({
      allocations: [
        { invoiceId: 'old', amount: '100' },
        { invoiceId: 'new', amount: '50' },
      ],
      credit: '25',
    })
  })

  it('derives receivable status from immutable totals and allocations', () => {
    expect(receivableStatus('100', '0')).toBe('متأخر')
    expect(receivableStatus('100', '40')).toBe('جزئي')
    expect(receivableStatus('100', '100')).toBe('مسدد')
  })
})
