import { decimalToUnits, unitsToDecimal } from './accounting'

type PaidCost = { clientId?: string; usd: string }
type OpenCost = { clientId?: string; total: string; paid: string }

/** Snapshot expenses contain active payments only. Add just the unpaid liability remainder. */
export function clientDirectCosts(clientId: string, expenses: PaidCost[], liabilities: OpenCost[]) {
  const paid = expenses.filter(row => row.clientId === clientId)
    .reduce((sum, row) => sum + decimalToUnits(row.usd), 0n)
  const open = liabilities.filter(row => row.clientId === clientId).reduce((sum, row) => {
    const remaining = decimalToUnits(row.total) - decimalToUnits(row.paid)
    return sum + (remaining > 0n ? remaining : 0n)
  }, 0n)
  return { paidExpenses: unitsToDecimal(paid), openLiabilities: unitsToDecimal(open), total: unitsToDecimal(paid + open) }
}
