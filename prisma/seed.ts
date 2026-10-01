import { CurrencyCode, PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

const ORGANIZATION_ID = '00000000-0000-0000-0000-000000000001'
const INITIAL_EXCHANGE_RATE_ID = '00000000-0000-0000-0000-000000000002'

const expenseCategories = [
  { id: '00000000-0000-0000-0000-000000000101', slug: 'operations', name: 'تشغيل' },
  { id: '00000000-0000-0000-0000-000000000102', slug: 'payroll', name: 'رواتب' },
  { id: '00000000-0000-0000-0000-000000000103', slug: 'rent', name: 'أجار' },
  { id: '00000000-0000-0000-0000-000000000104', slug: 'services', name: 'خدمات' },
  { id: '00000000-0000-0000-0000-000000000105', slug: 'software', name: 'برامج' },
  { id: '00000000-0000-0000-0000-000000000106', slug: 'hosting', name: 'استضافة' },
  { id: '00000000-0000-0000-0000-000000000107', slug: 'other', name: 'أخرى' },
] as const

async function main() {
  await prisma.$transaction(async tx => {
    await tx.organization.upsert({
      where: { id: ORGANIZATION_ID },
      update: {},
      create: {
        id: ORGANIZATION_ID,
        name: 'OZMO Media',
        timezone: 'Asia/Damascus',
        reportingCurrency: CurrencyCode.USD,
      },
    })

    await tx.appSetting.upsert({
      where: {
        organizationId_key: {
          organizationId: ORGANIZATION_ID,
          key: 'schemaVersion',
        },
      },
      update: {},
      create: {
        organizationId: ORGANIZATION_ID,
        key: 'schemaVersion',
        value: 1,
      },
    })

    await tx.exchangeRate.upsert({
      where: { id: INITIAL_EXCHANGE_RATE_ID },
      update: {},
      create: {
        id: INITIAL_EXCHANGE_RATE_ID,
        organizationId: ORGANIZATION_ID,
        baseCurrency: CurrencyCode.USD,
        quoteCurrency: CurrencyCode.SYP,
        rate: '12000',
        effectiveAt: new Date('2026-09-30T00:00:00.000Z'),
        source: 'Initial system default',
      },
    })

    for (const category of expenseCategories) {
      await tx.expenseCategory.upsert({
        where: {
          organizationId_slug: {
            organizationId: ORGANIZATION_ID,
            slug: category.slug,
          },
        },
        update: {},
        create: {
          id: category.id,
          organizationId: ORGANIZATION_ID,
          slug: category.slug,
          name: category.name,
        },
      })
    }
  })
}

main()
  .then(async () => {
    await prisma.$disconnect()
  })
  .catch(async error => {
    console.error(error)
    await prisma.$disconnect()
    process.exit(1)
  })
