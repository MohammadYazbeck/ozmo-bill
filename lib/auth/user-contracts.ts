import { z } from 'zod'
import { validUserPassword } from './passwords'

const fields = {
  name: z.string().trim().min(1).max(100),
  role: z.enum(['VIEWER', 'EDITOR']),
}
const password = z.string().refine(validUserPassword, 'كلمة المرور ضعيفة؛ استخدم 12 محرفًا على الأقل و6 محارف مختلفة.')
export const userCommandSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('create'), username: z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9._-]{2,63}$/), ...fields, password }),
  z.strictObject({ type: z.literal('update'), id: z.uuid(), version: z.int().positive(), ...fields, active: z.boolean(), password: password.optional() }),
])
export type UserCommand = z.infer<typeof userCommandSchema>
