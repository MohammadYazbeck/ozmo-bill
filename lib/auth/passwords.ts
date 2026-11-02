import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'

const options = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }
const derive = (password: string, salt: string) => new Promise<Buffer>((resolve, reject) => {
  scrypt(password, salt, 64, options, (error, key) => error ? reject(error) : resolve(key))
})

export function validUserPassword(password: string) {
  return password.length >= 12 && password.length <= 128 && new Set(password).size >= 6
}

export async function hashPassword(password: string) {
  if (!validUserPassword(password)) throw new Error('كلمة المرور يجب أن تكون بين 12 و128 محرفًا وتحتوي على 6 محارف مختلفة على الأقل.')
  const salt = randomBytes(16).toString('hex')
  return `scrypt-v1$${salt}$${(await derive(password, salt)).toString('hex')}`
}

// The same work is performed for unknown/disabled users; no plaintext is persisted.
export const dummyPasswordHash = `scrypt-v1$${'0'.repeat(32)}$${'0'.repeat(128)}`
export async function verifyPassword(password: string, encoded: string) {
  if (password.length > 128) return false
  const [version, salt, key, extra] = encoded.split('$')
  if (version !== 'scrypt-v1' || !/^[a-f0-9]{32}$/.test(salt ?? '') || !/^[a-f0-9]{128}$/.test(key ?? '') || extra !== undefined) return false
  return timingSafeEqual(await derive(password, salt), Buffer.from(key, 'hex'))
}
