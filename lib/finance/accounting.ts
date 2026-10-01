const MONEY_DIGITS = 4
const MONEY_SCALE = 10n ** BigInt(MONEY_DIGITS)
const RATE_DIGITS = 8
const RATE_SCALE = 10n ** BigInt(RATE_DIGITS)

export type FifoInvoice = {
  id: string
  due: string
}

export type FifoAllocation = {
  invoiceId: string
  amount: string
}

/** Converts a positive decimal string with at most four places to fixed money units. */
export function decimalToUnits(value: string) {
  return decimalToScaledUnits(value, MONEY_DIGITS)
}

export function unitsToDecimal(value: bigint) {
  if (value < 0n) throw new Error('Money cannot be negative.')

  const whole = value / MONEY_SCALE
  const fraction = (value % MONEY_SCALE).toString().padStart(MONEY_DIGITS, '0').replace(/0+$/, '')
  return fraction ? `${whole}.${fraction}` : whole.toString()
}

/** Converts an original-currency amount to USD using an immutable SYP/USD rate snapshot. */
export function usdEquivalent(amount: string, currency: 'USD' | 'SYP', rate: string) {
  if (currency === 'USD') return unitsToDecimal(decimalToUnits(amount))

  const amountUnits = decimalToUnits(amount)
  const rateUnits = decimalToScaledUnits(rate, RATE_DIGITS)
  if (rateUnits === 0n) throw new Error('Exchange rate must be greater than zero.')

  // amount/rate, rounded half-up to the database money scale.
  return unitsToDecimal((amountUnits * RATE_SCALE + rateUnits / 2n) / rateUnits)
}

/** Allocates a USD payment oldest-first and preserves any excess as customer credit. */
export function allocatePaymentFifo(payment: string, invoices: FifoInvoice[]) {
  let remaining = decimalToUnits(payment)
  const allocations: FifoAllocation[] = []

  for (const invoice of invoices) {
    if (remaining === 0n) break
    const due = decimalToUnits(invoice.due)
    if (due === 0n) continue
    const amount = remaining < due ? remaining : due
    allocations.push({ invoiceId: invoice.id, amount: unitsToDecimal(amount) })
    remaining -= amount
  }

  return { allocations, credit: unitsToDecimal(remaining) }
}

export function receivableStatus(total: string, paid: string): 'مسدد' | 'جزئي' | 'متأخر' {
  const totalUnits = decimalToUnits(total)
  const paidUnits = decimalToUnits(paid)
  if (paidUnits >= totalUnits) return 'مسدد'
  return paidUnits > 0n ? 'جزئي' : 'متأخر'
}

function decimalToScaledUnits(value: string, digits: number) {
  const pattern = new RegExp(`^\\d+(?:\\.\\d{1,${digits}})?$`)
  if (!pattern.test(value)) {
    throw new Error(`Expected a non-negative decimal with at most ${digits} fractional digits.`)
  }

  const scale = 10n ** BigInt(digits)
  const [whole, fraction = ''] = value.split('.')
  return BigInt(whole) * scale + BigInt(fraction.padEnd(digits, '0'))
}
