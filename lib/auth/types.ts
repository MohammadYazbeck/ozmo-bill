export type UserRole = 'OWNER' | 'EDITOR' | 'VIEWER'
export type Principal = { id: string; username: string; name: string; role: UserRole }
export type UserDto = Principal & { active: boolean; version: number; createdAt: string; updatedAt: string; createdBy?: string }
export const canEditFinance = (user: Principal) => user.role === 'OWNER' || user.role === 'EDITOR'
export const canManageUsers = (user: Principal) => canEditFinance(user)
export const roleLabel = (role: UserRole) => role === 'OWNER' ? 'المالك' : role === 'EDITOR' ? 'تعديل' : 'مشاهدة فقط'
