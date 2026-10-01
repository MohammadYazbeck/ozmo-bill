import { z } from 'zod'

const envSchema = z.object({
  DATABASE_URL: z.string().startsWith('postgresql://', 'DATABASE_URL must use postgresql://'),
  APP_TIME_ZONE: z.string().min(1).default('Asia/Damascus').refine(isTimeZone, 'APP_TIME_ZONE must be a valid IANA time zone'),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
}).superRefine((value, context) => {
  if (value.NODE_ENV === 'production' && value.DATABASE_URL.includes('replace_with')) {
    context.addIssue({
      code: 'custom',
      path: ['DATABASE_URL'],
      message: 'DATABASE_URL still contains a placeholder value',
    })
  }
})

const localDatabaseUrl = 'postgresql://ozmo_app:ozmo_app_dev_password@127.0.0.1:55433/ozmo_bill?schema=public'

export type AppEnv = z.infer<typeof envSchema>

export function resolveDatabaseUrl() {
  return process.env.DATABASE_URL ?? (process.env.NODE_ENV === 'production' ? undefined : localDatabaseUrl)
}

export function getEnv(): AppEnv {
  return envSchema.parse({
    DATABASE_URL: resolveDatabaseUrl(),
    APP_TIME_ZONE: process.env.APP_TIME_ZONE,
    NODE_ENV: process.env.NODE_ENV,
  })
}

function isTimeZone(value: string) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format()
    return true
  } catch {
    return false
  }
}
