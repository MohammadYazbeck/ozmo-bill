'use client'

export type InvoiceClient = {
  name: string
  monthly: number
  due: number
  package?: string
  invoiceNumber?: string
  invoiceDate?: string
  invoiceDueDate?: string
  invoiceSubtotal?: number
  invoiceTotal?: number
  invoicePaid?: number
  invoiceDue?: number
  invoiceOpeningBalance?: number
  invoiceLines?: Array<{
    description: string
    quantity: number
    unitAmount: number
    total: number
  }>
}

export type InvoiceExportRow = [string, number | null, number | null, number | null]

const orange = 'FF5A0A'
const cream = 'FFF8E8'
const navy = '17427A'
const gray = '5F5F5F'
const green = '27852B'
const line = '8B8B8B'

function dateText(date: Date) {
  return new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' }).format(date)
}

function monthText(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
}

function safeFileName(value: string) {
  return value.replace(/[\\/:*?"<>|]/g, '-').trim()
}

export function buildInvoiceExportRows(client: InvoiceClient, invoiceDate: Date): InvoiceExportRow[] {
  const descriptions: InvoiceExportRow[] = []
  if (client.invoiceLines) {
    descriptions.push(...client.invoiceLines.map(lineItem => ([
      lineItem.description,
      lineItem.quantity,
      lineItem.unitAmount,
      lineItem.total,
    ] as InvoiceExportRow)))
  } else {
    const outstanding = client.due > 0 ? client.due : client.monthly
    const previousBalance = Math.max(outstanding - client.monthly, 0)
    const currentBalance = client.invoiceDue ?? client.invoiceTotal ?? Math.min(outstanding, client.monthly)
    if (previousBalance > 0) {
      descriptions.push([
        `Previous subscription balance before ${monthText(invoiceDate)}`,
        1,
        previousBalance,
        previousBalance,
      ])
    }
    descriptions.push([
      `${client.package || 'Social Media'} monthly subscription (${monthText(invoiceDate)})`,
      1,
      currentBalance,
      currentBalance,
    ])
  }

  const paid = Math.max(client.invoicePaid ?? 0, 0)
  if (paid > 0 && client.invoiceLines) {
    descriptions.push(['Payment received', 1, -paid, -paid])
  }
  return descriptions
}

export async function downloadInvoiceXlsx(client: InvoiceClient, clientIndex: number) {
  const ExcelJS = await import('exceljs')
  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'OZMO Finance'
  workbook.created = new Date()
  const sheet = workbook.addWorksheet('Invoice', {
    views: [{ showGridLines: false }],
    pageSetup: { paperSize: 9, orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 1 },
  })

  const widths = [4, 10, 10, 10, 10, 10, 10, 10, 8, 8, 10, 10, 11, 11]
  widths.forEach((width, index) => { sheet.getColumn(index + 1).width = width })
  for (let row = 1; row <= 40; row += 1) sheet.getRow(row).height = row === 1 || row === 40 ? 10 : 22

  for (let row = 1; row <= 40; row += 1) {
    for (let col = 1; col <= 14; col += 1) {
      const cell = sheet.getCell(row, col)
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: cream } }
      cell.font = { name: 'Arial', size: 11, color: { argb: gray } }
      cell.alignment = { vertical: 'middle' }
    }
  }

  const border = { style: 'medium' as const, color: { argb: 'A7A7A7' } }
  for (let col = 1; col <= 14; col += 1) {
    sheet.getCell(2, col).border = { top: border }
    sheet.getCell(39, col).border = { bottom: border }
  }
  for (let row = 2; row <= 39; row += 1) {
    sheet.getCell(row, 1).border = { left: border }
    sheet.getCell(row, 14).border = { right: border }
  }

  sheet.mergeCells('B3:E5')
  sheet.getCell('B3').value = 'Nouri Basha St.\nDamascus, Syria\n+963 982 475 910'
  sheet.getCell('B3').alignment = { vertical: 'top', horizontal: 'left', wrapText: true }

  const logoResponse = await fetch('/logo-ozmo-mark.png')
  const logoBuffer = await logoResponse.arrayBuffer()
  const logoId = workbook.addImage({ buffer: logoBuffer, extension: 'png' })
  sheet.addImage(logoId, { tl: { col: 8.4, row: 2 }, ext: { width: 112, height: 112 } })

  sheet.mergeCells('B8:G9')
  sheet.getCell('B8').value = 'Invoice'
  sheet.getCell('B8').font = { name: 'Arial', size: 28, bold: true, color: { argb: orange } }
  sheet.getCell('B8').alignment = { horizontal: 'left', vertical: 'bottom' }
  sheet.mergeCells('B10:G10')
  const invoiceDate = client.invoiceDate ? new Date(`${client.invoiceDate}T00:00:00`) : new Date()
  const invoiceDueDate = client.invoiceDueDate ? new Date(`${client.invoiceDueDate}T00:00:00`) : invoiceDate
  sheet.getCell('B10').value = `Submitted on ${dateText(invoiceDate)}`
  sheet.getCell('B10').font = { name: 'Arial', size: 12, bold: true, color: { argb: orange } }
  sheet.getCell('B10').alignment = { horizontal: 'left' }

  const invoiceNumber = client.invoiceNumber ?? `OZ-${monthText(invoiceDate).replace('-', '')}-${String(clientIndex + 1).padStart(3, '0')}`
  const blocks = [
    ['B13:E13', 'B14:E15', 'Invoice for', client.name],
    ['I13:J13', 'I14:J15', 'Payable to', 'OZMO'],
    ['L13:N13', 'L14:N15', 'Invoice #', invoiceNumber],
    ['I17:J17', 'I18:J19', 'Project', client.package || 'Social Media'],
    ['L17:N17', 'L18:N19', 'Due date', dateText(invoiceDueDate)],
  ]
  blocks.forEach(([labelRange, valueRange, label, value]) => {
    sheet.mergeCells(labelRange)
    sheet.mergeCells(valueRange)
    const labelCell = sheet.getCell(labelRange.split(':')[0])
    const valueCell = sheet.getCell(valueRange.split(':')[0])
    labelCell.value = label
    valueCell.value = value
    labelCell.font = { name: 'Arial', size: 11, bold: true, color: { argb: gray } }
    valueCell.font = { name: 'Arial', size: 10, bold: true, color: { argb: gray } }
    labelCell.alignment = { horizontal: 'left' }
    valueCell.alignment = { horizontal: 'left', vertical: 'top', wrapText: true }
  })

  const headers = [['B21:H21', 'Description'], ['I21:J21', 'Qty'], ['K21:L21', 'Unit price'], ['M21:N21', 'Total price']]
  headers.forEach(([range, label]) => {
    sheet.mergeCells(range)
    const cell = sheet.getCell(range.split(':')[0])
    cell.value = label
    cell.font = { name: 'Arial', size: 10, bold: true, color: { argb: navy } }
    cell.alignment = { horizontal: 'left', vertical: 'middle' }
  })

  const descriptions = buildInvoiceExportRows(client, invoiceDate)
  const invoiceBalance = client.invoiceDue ?? Math.max(
    descriptions.reduce((sum, row) => sum + (row[3] ?? 0), 0),
    0,
  )
  while (descriptions.length < 6) descriptions.push(['', null, null, null])

  descriptions.slice(0, 6).forEach(([description, quantity, unitPrice, lineTotal], index) => {
    const row = 22 + index
    sheet.mergeCells(`B${row}:H${row}`)
    sheet.mergeCells(`I${row}:J${row}`)
    sheet.mergeCells(`K${row}:L${row}`)
    sheet.mergeCells(`M${row}:N${row}`)
    sheet.getCell(`B${row}`).value = description
    sheet.getCell(`I${row}`).value = quantity
    sheet.getCell(`K${row}`).value = unitPrice
    sheet.getCell(`M${row}`).value = lineTotal === null
      ? { formula: `IF(OR(I${row}="",K${row}=""),"",I${row}*K${row})` }
      : { formula: `I${row}*K${row}`, result: lineTotal }
    for (let col = 2; col <= 14; col += 1) {
      const cell = sheet.getCell(row, col)
      const thin = { style: 'thin' as const, color: { argb: line } }
      cell.border = { top: thin, bottom: thin, left: thin, right: thin }
      cell.font = { name: 'Arial', size: 10, color: { argb: gray } }
      cell.alignment = { vertical: 'middle', horizontal: col <= 8 ? 'left' : 'right' }
    }
    sheet.getCell(`I${row}`).numFmt = '0'
    sheet.getCell(`K${row}`).numFmt = '$#,##0.00'
    sheet.getCell(`M${row}`).numFmt = '$#,##0.00'
  })

  sheet.mergeCells('B30:H30')
  sheet.getCell('B30').value = 'Notes:'
  sheet.getCell('B30').font = { name: 'Arial', size: 11, bold: true, color: { argb: gray } }
  sheet.getCell('B30').alignment = { horizontal: 'left' }
  sheet.mergeCells('B31:H34')
  sheet.getCell('B31').value = ''
  if ((client.invoiceOpeningBalance ?? 0) > 0) {
    sheet.getCell('B31').value = `Previous account balance (not included in this invoice): $${client.invoiceOpeningBalance?.toFixed(2)}`
  }
  sheet.getCell('B31').alignment = { horizontal: 'right', vertical: 'top', wrapText: true, readingOrder: 'rtl' }

  sheet.mergeCells('J30:L30')
  sheet.getCell('J30').value = 'Invoice total'
  sheet.getCell('J30').font = { name: 'Arial', size: 11, bold: true, color: { argb: gray } }
  sheet.getCell('J30').alignment = { horizontal: 'left' }
  sheet.mergeCells('M30:N30')
  sheet.getCell('M30').value = { formula: 'SUM(M22:M27)', result: invoiceBalance }
  sheet.getCell('M30').numFmt = '$#,##0.00'
  sheet.getCell('M30').font = { name: 'Arial', size: 11, bold: true, color: { argb: '000000' } }
  sheet.getCell('M30').alignment = { horizontal: 'right' }
  sheet.mergeCells('K32:N34')
  sheet.getCell('K32').value = { formula: 'M30', result: invoiceBalance }
  sheet.getCell('K32').numFmt = '$#,##0.00'
  sheet.getCell('K32').font = { name: 'Arial', size: 24, bold: true, color: { argb: green } }
  sheet.getCell('K32').alignment = { horizontal: 'right', vertical: 'middle' }

  sheet.mergeCells('B37:N37')
  sheet.getCell('B37').value = 'If you have any questions concerning this invoice, use the following contact information:'
  sheet.getCell('B37').font = { name: 'Arial', size: 9, bold: true, color: { argb: '000000' } }
  sheet.mergeCells('B38:N38')
  sheet.getCell('B38').value = 'OZMO AGENCY, +963 982 475 910'
  sheet.getCell('B38').font = { name: 'Arial', size: 10, bold: true, color: { argb: orange } }

  const buffer = await workbook.xlsx.writeBuffer()
  const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `${safeFileName(client.name)}_${monthText(invoiceDate)}_${safeFileName(invoiceNumber)}.xlsx`
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}
