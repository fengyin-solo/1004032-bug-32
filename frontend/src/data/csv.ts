/**
 * 极简 CSV 解析/序列化：
 * - 解析支持 UTF-8 BOM、双引号包裹、字段内逗号/换行/连续双引号转义；
 * - 序列化时对含逗号、引号、换行的单元格自动加引号，避免列错位。
 */

export type CsvRecord = Record<string, string>

export type CsvTable = {
  headers: string[]
  records: CsvRecord[]
}

function tokenize(text: string): string[][] {
  const rows: string[][] = []
  let field = ''
  let row: string[] = []
  let inQuotes = false

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 1
        } else {
          inQuotes = false
        }
      } else {
        field += ch
      }
    } else if (ch === '"') {
      inQuotes = true
    } else if (ch === ',') {
      row.push(field)
      field = ''
    } else if (ch === '\n') {
      row.push(field)
      rows.push(row)
      field = ''
      row = []
    } else if (ch === '\r') {
      if (text[i + 1] === '\n') {
        i += 1
      }
      row.push(field)
      rows.push(row)
      field = ''
      row = []
    } else {
      field += ch
    }
  }

  // 文件末尾没有换行符时，补上最后一个字段/行。
  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

export function parseCsv(text: string): CsvTable {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const matrix = tokenize(source)
  if (matrix.length === 0) {
    return { headers: [], records: [] }
  }

  const headers = matrix[0].map((cell) => cell.trim())
  const records: CsvRecord[] = []
  for (let r = 1; r < matrix.length; r++) {
    const cells = matrix[r]
    // 跳过完全空白的行（含末尾空行）。
    if (cells.length === 1 && cells[0].trim() === '') {
      continue
    }
    const record: CsvRecord = {}
    headers.forEach((header, index) => {
      record[header] = (cells[index] ?? '').trim()
    })
    records.push(record)
  }
  return { headers, records }
}

export function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value)
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export function stringifyCsv(
  headers: string[],
  records: Array<Record<string, unknown>>,
): string {
  const lines = [headers.map(csvCell).join(',')]
  for (const record of records) {
    lines.push(headers.map((header) => csvCell(record[header])).join(','))
  }
  return `﻿${lines.join('\r\n')}`
}
