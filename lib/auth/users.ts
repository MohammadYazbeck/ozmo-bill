import 'server-only'
import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { hashPassword } from './passwords'
import { ORGANIZATION_ID } from './request'
import { canManageUsers, type Principal, type UserDto } from './types'
import type { UserCommand } from './user-contracts'
import { creationAuthors } from '@/lib/finance/creation-authors'

const publicFields = { id: true, username: true, name: true, role: true, active: true, version: true, createdAt: true, updatedAt: true } as const
type PublicUser = Prisma.AppUserGetPayload<{ select: typeof publicFields }>
const dto = (row: PublicUser): UserDto => ({ ...row, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() })

export class UserManagementError extends Error {
  constructor(message: string, public status = 409) { super(message) }
}

function requireOwner(user: Principal) {
  if (!canManageUsers(user)) throw new UserManagementError('إدارة المستخدمين تحتاج إلى صلاحية تعديل.', 403)
}

export async function listUsers(owner: Principal) {
  requireOwner(owner)
  const rows = await db.appUser.findMany({ where: { organizationId: ORGANIZATION_ID }, select: publicFields, orderBy: { createdAt: 'asc' } })
  const authors = creationAuthors(await db.auditEvent.findMany({
    where: { organizationId: ORGANIZATION_ID, entityType: 'AppUser', action: 'CREATE' },
    orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
    select: { actor: true, entityType: true, entityId: true, metadata: true },
  }))
  return rows.map(row => ({ ...dto(row), ...(authors[`AppUser:${row.id}`] ? { createdBy: authors[`AppUser:${row.id}`] } : {}) }))
}

export async function manageUser(owner: Principal, command: UserCommand) {
  requireOwner(owner)
  if (command.type === 'create' && command.username === process.env.ADMIN_USERNAME?.toLowerCase()) throw new UserManagementError('اسم المستخدم محجوز لحساب المالك.')
  const passwordHash = command.password ? await hashPassword(command.password) : undefined
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await db.$transaction(async tx => {
        let before: PublicUser | null = null
        let after: PublicUser
        if (command.type === 'create') {
          if (!passwordHash) throw new UserManagementError('أدخل كلمة المرور.', 422)
          after = await tx.appUser.create({ data: {
            organizationId: ORGANIZATION_ID, username: command.username, name: command.name,
            passwordHash, role: command.role,
          }, select: publicFields })
        } else {
          before = await tx.appUser.findFirst({ where: { id: command.id, organizationId: ORGANIZATION_ID }, select: publicFields })
          if (!before) throw new UserManagementError('المستخدم غير موجود.', 404)
          if (before.version !== command.version) throw new UserManagementError('تم تعديل الحساب من نافذة أخرى. حدّث القائمة وأعد المحاولة.')
          const changed = await tx.appUser.updateMany({ where: { id: before.id, organizationId: ORGANIZATION_ID, version: command.version }, data: {
            name: command.name, role: command.role, active: command.active, version: { increment: 1 },
            ...(passwordHash ? { passwordHash } : {}),
          } })
          if (changed.count !== 1) throw new UserManagementError('تغيّر الحساب أثناء الحفظ. حدّث القائمة.')
          after = (await tx.appUser.findUnique({ where: { id: before.id }, select: publicFields }))!
        }
        await tx.auditEvent.create({ data: {
          organizationId: ORGANIZATION_ID, actor: owner.username, entityType: 'AppUser', entityId: after.id,
          action: command.type === 'create' ? 'CREATE' : 'UPDATE',
          ...(before ? { before: dto(before) } : {}), after: dto(after),
          metadata: { source: 'user-management', actorName: owner.name, passwordChanged: Boolean(passwordHash) },
        } })
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
      return await listUsers(owner)
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError) {
        if (error.code === 'P2034' && attempt < 2) continue
        if (error.code === 'P2002') throw new UserManagementError('اسم المستخدم موجود مسبقًا؛ اختر اسمًا آخر.')
      }
      throw error
    }
  }
  throw new UserManagementError('تعذّر حفظ الحساب. حاول مجددًا.')
}
