type CreationAudit = { entityType: string; entityId: string; actor: string | null; metadata: unknown }

/** Audits must be oldest first. Later edits must never become the original creator. */
export function creationAuthors(audits: CreationAudit[]) {
  const result: Record<string, string> = {}
  for (const audit of audits) {
    const key = `${audit.entityType}:${audit.entityId}`
    if (result[key]) continue
    const metadata = audit.metadata && typeof audit.metadata === 'object' ? audit.metadata as Record<string, unknown> : {}
    const name = typeof metadata.actorName === 'string' && metadata.actorName.trim() ? metadata.actorName : audit.actor
    if (name) result[key] = name === 'system' ? 'النظام تلقائيًا' : name
  }
  return result
}
