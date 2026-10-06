import { listRows, saveRows } from '@/data/local-store'
import type { EntryRow } from '@/data/types'

// 流量监测数据文件上传：解析、校验、去重入库都在这里，页面只负责交互。
// 约定：
// - 同一「监测点编号 + 监测时段」视为同一条记录，重复上传只更新不新增；
// - 更新已有记录时只覆盖数据字段，原有状态（在线/离线/数据异常/已校准）一律保留；
// - 分批落盘，上传中断时已完成的批次保留，剩余条目可继续上传。

const MODULE_KEY = 'flow_monitor'

const UNIQUE_FIELDS = ['监测点编号', '监测时段'] as const

// 上传文件里必须出现的列；其余模块字段（如「数据状态」）出现才导入，不出现就保留原值。
const REQUIRED_COLUMNS = ['监测点编号', '监测点位', '监测时段', '瞬时流量', '累计流量', '水位标高', '流速'] as const

const IMPORTABLE_FIELDS = [...REQUIRED_COLUMNS, '数据状态'] as const

// 指标合理范围：缺值、非数值或超出范围的行判为无效，不入库。
const METRIC_RANGES = [
  { field: '瞬时流量', min: 0, max: 10000, unit: 'm³/h' },
  { field: '累计流量', min: 0, max: 1_000_000_000, unit: 'm³' },
  { field: '水位标高', min: -50, max: 200, unit: 'm' },
  { field: '流速', min: 0, max: 20, unit: 'm/s' },
] as const

// 测点编号：字母或数字开头，可含数字、字母、短横线，3~32 位。
const CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{2,31}$/

// 每批处理条数：每批落一次盘，中断时已完成的批次不会丢。
const CHUNK_SIZE = 50

export type ValidRow = {
  line: number
  fields: Record<string, string>
}

export type RowFailure = {
  line: number
  reason: string
}

export type ParseOutcome = {
  valid: ValidRow[]
  failures: RowFailure[]
  headerError: string
}

export type ImportOutcome = {
  created: number
  updated: number
  done: number
  total: number
  finished: boolean
  remaining: ValidRow[]
}

function uniqueKey(fields: Record<string, unknown>): string {
  return UNIQUE_FIELDS.map((name) => String(fields[name] ?? '').trim()).join('\u001f')
}

// 解析 CSV 文本：支持带引号的单元格（内部可含逗号、换行），兼容 BOM 与 CRLF。
function parseCsvText(text: string): string[][] {
  const rows: string[][] = []
  const source = text.replace(/^\uFEFF/, '')
  let row: string[] = []
  let cell = ''
  let inQuotes = false
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i]
    if (inQuotes) {
      if (ch === '"') {
        if (source[i + 1] === '"') {
          cell += '"'
          i += 1
        } else {
          inQuotes = false
        }
      } else {
        cell += ch
      }
      continue
    }
    if (ch === '"') {
      inQuotes = true
    } else if (ch === ',') {
      row.push(cell)
      cell = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && source[i + 1] === '\n') {
        i += 1
      }
      row.push(cell)
      cell = ''
      rows.push(row)
      row = []
    } else {
      cell += ch
    }
  }
  row.push(cell)
  if (row.length > 1 || row[0].trim() !== '') {
    rows.push(row)
  }
  return rows
}

// 时段单边：YYYY-MM-DD，可带 HH:mm 或 HH:mm:ss；拒绝 2026-02-31 这类不存在的日期。
function parsePeriodBound(text: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(text.trim())
  if (!match) {
    return null
  }
  const [, year, month, day, hour = '0', minute = '0', second = '0'] = match
  const date = new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  )
  if (
    date.getFullYear() !== Number(year) ||
    date.getMonth() !== Number(month) - 1 ||
    date.getDate() !== Number(day)
  ) {
    return null
  }
  return date.getTime()
}

// 监测时段：单个时间点，或用 ~ / 至 连接的区间；区间要求起止都合法且起不晚于止。
export function isValidPeriod(period: string): boolean {
  const parts = period
    .split(/[~至]/)
    .map((item) => item.trim())
    .filter((item) => item !== '')
  if (parts.length === 0 || parts.length > 2) {
    return false
  }
  const bounds = parts.map(parsePeriodBound)
  if (bounds.some((item) => item === null)) {
    return false
  }
  return parts.length === 1 || (bounds[0] as number) <= (bounds[1] as number)
}

function validateRow(fields: Record<string, string>): string | null {
  const code = fields['监测点编号'] ?? ''
  if (code === '') {
    return '监测点编号为空'
  }
  if (!CODE_PATTERN.test(code)) {
    return `监测点编号「${code}」格式不正确（字母或数字开头，可含短横线，3~32 位）`
  }
  if ((fields['监测点位'] ?? '').trim() === '') {
    return '监测点位为空'
  }
  const period = fields['监测时段'] ?? ''
  if (period.trim() === '') {
    return '监测时段为空'
  }
  if (!isValidPeriod(period)) {
    return `监测时段「${period}」不是有效的日期或时段`
  }
  for (const { field, min, max, unit } of METRIC_RANGES) {
    const raw = (fields[field] ?? '').trim()
    if (raw === '') {
      return `${field}为空`
    }
    const value = Number(raw)
    if (!Number.isFinite(value)) {
      return `${field}「${raw}」不是数值`
    }
    if (value < min || value > max) {
      return `${field}「${raw}」超出合理范围 ${min}~${max}${unit}`
    }
  }
  return null
}

// 解析并校验整个文件：任何一行不合格都不入库，只进 failures 清单。
export function parseFlowFile(text: string): ParseOutcome {
  const rows = parseCsvText(text).filter((cells) => cells.some((cell) => cell.trim() !== ''))
  if (rows.length === 0) {
    return { valid: [], failures: [], headerError: '文件内容为空' }
  }
  const header = rows[0].map((cell) => cell.trim())
  const columnIndex = new Map(header.map((name, index) => [name, index]))
  const missing = REQUIRED_COLUMNS.filter((name) => !columnIndex.has(name))
  if (missing.length > 0) {
    return { valid: [], failures: [], headerError: `文件缺少必需列：${missing.join('、')}` }
  }
  const valid: ValidRow[] = []
  const failures: RowFailure[] = []
  const seenLines = new Map<string, number>()
  for (let i = 1; i < rows.length; i += 1) {
    const line = i + 1
    const fields: Record<string, string> = {}
    for (const name of IMPORTABLE_FIELDS) {
      const index = columnIndex.get(name)
      if (index !== undefined) {
        fields[name] = (rows[i][index] ?? '').trim()
      }
    }
    const error = validateRow(fields)
    if (error !== null) {
      failures.push({ line, reason: error })
      continue
    }
    const key = uniqueKey(fields)
    const firstLine = seenLines.get(key)
    if (firstLine !== undefined) {
      failures.push({ line, reason: `与第 ${firstLine} 行重复（同监测点、同时段）` })
      continue
    }
    seenLines.set(key, line)
    valid.push({ line, fields })
  }
  return { valid, failures, headerError: '' }
}

function sleep(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0)
  })
}

// 分批 upsert：每批结束落盘并回报进度；shouldAbort 返回 true 时停止，
// 已完成的条目保留，未处理的条目放进 remaining 供继续上传。
export async function importValidRows(
  rows: ValidRow[],
  onProgress?: (done: number, total: number) => void,
  shouldAbort?: () => boolean,
): Promise<ImportOutcome> {
  const total = rows.length
  const entries = listRows(MODULE_KEY).map((row) => ({ ...row }))
  const indexByKey = new Map<string, number>()
  entries.forEach((row, index) => {
    indexByKey.set(uniqueKey(row), index)
  })
  let nextId = entries.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
  let created = 0
  let updated = 0
  let done = 0
  while (done < total) {
    if (shouldAbort?.()) {
      break
    }
    const chunk = rows.slice(done, done + CHUNK_SIZE)
    for (const item of chunk) {
      const key = uniqueKey(item.fields)
      const existing = indexByKey.get(key)
      if (existing === undefined) {
        const entry: EntryRow = {
          id: nextId,
          status: '在线',
          pending: true,
          abnormal: false,
          ...item.fields,
        }
        nextId += 1
        indexByKey.set(key, entries.length)
        entries.push(entry)
        created += 1
      } else {
        // 只更新数据字段：原有状态与 pending/abnormal 标记一律保留。
        entries[existing] = { ...entries[existing], ...item.fields }
        updated += 1
      }
    }
    done += chunk.length
    saveRows(MODULE_KEY, entries)
    onProgress?.(done, total)
    if (done < total) {
      await sleep()
    }
  }
  return {
    created,
    updated,
    done,
    total,
    finished: done >= total,
    remaining: rows.slice(done),
  }
}
