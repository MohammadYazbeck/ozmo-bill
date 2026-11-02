import { describe, expect, it } from 'vitest'
import { creationAuthors } from '@/lib/finance/creation-authors'

describe('original record attribution', () => {
  it('uses the snapshotted display name and keeps the first creator after later events', () => {
    const entry = { entityType: 'Client', entityId: '1', actor: 'ghaith', metadata: { actorName: 'غيث' } }
    expect(creationAuthors([entry, { ...entry, actor: 'editor', metadata: { actorName: 'معدل' } }])).toEqual({ 'Client:1': 'غيث' })
  })
  it('does not invent names for historical records without metadata', () => {
    expect(creationAuthors([{ entityType: 'CashEntry', entityId: '2', actor: 'admin', metadata: null }])).toEqual({ 'CashEntry:2': 'admin' })
    expect(creationAuthors([])).toEqual({})
  })
  it('labels automatic records as system, not the person opening the page', () => {
    expect(creationAuthors([{ entityType: 'PayrollItem', entityId: '3', actor: 'system', metadata: {} }])).toEqual({ 'PayrollItem:3': 'النظام تلقائيًا' })
  })
})
