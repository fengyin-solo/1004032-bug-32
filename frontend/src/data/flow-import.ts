import { listRows, saveRows } from './local-store'
import { parseCsv, stringifyCsv } from './csv'
import type { EntryRow } from './types'

/**
 * 流量监测数据文件导入：
 * - 上传前整文件校验测点编号、监测时段、指标范围，文件级错误直接拒收；
 * - 按测点编号 upsert：重复上传同一文件只更新已有记录，不新增监测点；
 * - 更新已有测点时保留原有在线/离线等状态，新测点首次上报数据记为「在线」；
 * - 导入会话持久化到 localStorage，中断后可从失败项继续，已完成条目不会丢。
 */

const MODULE_KEY = 'flow_monitor'
const SESSION_KEY = 'underground-pipeline-inspection:flow-import-session'

export const FLOW_FIELDS = [
  '监测点编号',
  '监测点位',
  '监测时段',
  '瞬时流量',
  '累计流量',
  '水位标高',
  '流速',
] as const

export const FLOW_METRICS = ['瞬时流量', '累计流量', '水位标高', '流速'] as const

// 指标允许范围：超出区间视为越界数据，导入前拦截。
export const METRIC_RANGES: Record<string, { min: number; max: number }> = {
  瞬时流量: { min: 0, max: 10000 },
  累计流量: { min: 0, max: 100000000 },
  水位标高: { min: -50, max: 5000 },
  流速: { min: 0, max: 20 },
}

export type FlowQuery = {
  keyword: string
  begin: string
  end: string
}

export type PrepareResult =
  | { ok: true; session: ImportSession }
  | { ok: false; message: string }

export type ImportRowState = 'pending' | 'committed' | 'failed' | 'skipped'

export type ImportRow = {
  index: number
  values: Record<string, string>
  state: ImportRowState
  error: string
  action: 'create' | 'update' | ''
}

export type ImportSession = {
  fileName: string
  rows: ImportRow[]
  updatedAt: number
}

const CODE_PATTERN = /^FLOW-\d{4,}$/

function parsePeriod(value: string): number | null {
  const text = value.trim()
  if (!/^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?)?$/.test(text)) {
    return null
  }
  const date = new Date(text.replace(' ', 'T'))
  return Number.isNaN(date.getTime()) ? null : date.getTime()
}

function validateRow(
  values: Record<string, string>,
  seenCodes: Map<string, number>,
  lineNo: number,
): string {
  const code = (values['监测点编号'] ?? '').trim()
  const point = (values['监测点位'] ?? '').trim()
  const period = (values['监测时段'] ?? '').trim()

  if (!code) {
    return `第${lineNo}行：测点编号不能为空`
  }
  if (!CODE_PATTERN.test(code)) {
    return `第${lineNo}行：测点编号 ${code} 格式应为 FLOW- 开头加至少4位数字`
  }
  const firstLine = seenCodes.get(code)
  if (firstLine !== undefined) {
    return `第${lineNo}行：测点编号 ${code} 与第${firstLine}行重复`
  }
  seenCodes.set(code, lineNo)

  if (!point) {
    return `第${lineNo}行：监测点位不能为空`
  }

  if (!period) {
    return `第${lineNo}行：监测时段不能为空`
  }
  const time = parsePeriod(period)
  if (time === null) {
    return `第${lineNo}行：监测时段 ${period} 不是合法时间（格式 YYYY-MM-DD 或 YYYY-MM-DD HH:mm:ss）`
  }
  if (time > Date.now()) {
    return `第${lineNo}行：监测时段 ${period} 不能晚于当前时间`
  }

  for (const metric of FLOW_METRICS) {
    const raw = (values[metric] ?? '').trim()
    if (!raw) {
      return `第${lineNo}行：${metric}不能为空`
    }
    const number = Number(raw)
    if (!Number.isFinite(number)) {
      return `第${lineNo}行：${metric} ${raw} 不是数值`
    }
    const range = METRIC_RANGES[metric]
    if (number < range.min || number > range.max) {
      return `第${lineNo}行：${metric} ${raw} 超出允许范围 [${range.min}, ${range.max}]`
    }
  }
  return ''
}

/** 读文件并整表校验，通过后生成待导入会话；任何错误都不写业务数据。 */
export function prepareFlowImport(
  fileName: string,
  text: string,
): PrepareResult {
  let table
  try {
    table = parseCsv(text)
  } catch {
    return { ok: false, message: '文件解析失败，请确认上传的是 UTF-8 编码的 CSV 文件' }
  }

  if (table.records.length === 0) {
    return { ok: false, message: '文件没有任何数据行，可先下载导入模板' }
  }

  const missing = FLOW_FIELDS.filter((field) => !table.headers.includes(field))
  if (missing.length > 0) {
    return { ok: false, message: `缺少必需列：${missing.join('、')}，请使用最新导入模板` }
  }

  const seenCodes = new Map<string, number>()
  const rows: ImportRow[] = table.records.map((record, i) => {
    const values: Record<string, string> = {}
    for (const field of FLOW_FIELDS) {
      values[field] = (record[field] ?? '').trim()
    }
    return {
      index: i,
      values,
      state: 'pending',
      error: validateRow(values, seenCodes, i + 2),
      action: '',
    }
  })

  const errorRows = rows.filter((row) => row.error !== '')
  if (errorRows.length > 0) {
    const previews = errorRows.slice(0, 5).map((row) => row.error)
    const more = errorRows.length > 5 ? `（等 ${errorRows.length} 条错误）` : ''
    return { ok: false, message: `校验未通过，未写入任何数据：\n${previews.join('；')}${more}` }
  }

  const session: ImportSession = { fileName, rows, updatedAt: Date.now() }
  persistSession(session)
  return { ok: true, session }
}

function toMetric(row: ImportRow, metric: string): number {
  return Number(row.values[metric])
}

/** 提交一行：按测点编号更新已有记录（保留原状态），不存在则新建为「在线」。 */
function commitRow(row: ImportRow): { action: 'create' | 'update' } {
  const rows = [...listRows(MODULE_KEY)]
  const code = row.values['监测点编号']
  const index = rows.findIndex((item) => String(item['监测点编号'] ?? '') === code)

  if (index >= 0) {
    const current = rows[index]
    rows[index] = {
      ...current,
      监测点编号: code,
      监测点位: row.values['监测点位'],
      监测时段: row.values['监测时段'],
      瞬时流量: toMetric(row, '瞬时流量'),
      累计流量: toMetric(row, '累计流量'),
      水位标高: toMetric(row, '水位标高'),
      流速: toMetric(row, '流速'),
      // 更新数据文件不改状态：原有在线/离线等状态原样保留。
      status: current.status,
      pending: current.pending,
      abnormal: current.abnormal,
    }
    saveRows(MODULE_KEY, rows)
    return { action: 'update' }
  }

  const id = rows.reduce((max, item) => Math.max(max, Number(item.id) || 0), 0) + 1
  rows.push({
    id,
    status: '在线',
    pending: true,
    abnormal: false,
    监测点编号: code,
    监测点位: row.values['监测点位'],
    监测时段: row.values['监测时段'],
    瞬时流量: toMetric(row, '瞬时流量'),
    累计流量: toMetric(row, '累计流量'),
    水位标高: toMetric(row, '水位标高'),
    流速: toMetric(row, '流速'),
  })
  saveRows(MODULE_KEY, rows)
  return { action: 'create' }
}

function persistSession(session: ImportSession): void {
  session.updatedAt = Date.now()
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(SESSION_KEY, JSON.stringify(session))
  }
}

/** 从第一个待处理条目继续导入；遇失败条目即暂停，已完成条目已落库并保留。 */
export function runFlowImport(session: ImportSession): ImportSession {
  for (const row of session.rows) {
    if (row.state !== 'pending') {
      continue
    }
    try {
      const { action } = commitRow(row)
      row.state = 'committed'
      row.action = action
      persistSession(session)
    } catch (error) {
      row.state = 'failed'
      row.error = error instanceof Error ? error.message : '写入本地数据失败'
      persistSession(session)
      break
    }
  }
  persistSession(session)
  return session
}

function revalidateRow(row: ImportRow, session: ImportSession): string {
  const seen = new Map<string, number>()
  for (const other of session.rows) {
    if (other.index === row.index) {
      continue
    }
    const code = other.values['监测点编号']
    if (code && CODE_PATTERN.test(code)) {
      seen.set(code, other.index + 2)
    }
  }
  return validateRow(row.values, seen, row.index + 2)
}

/** 修正失败项的字段后从该条目继续。 */
export function fixFlowImportRow(
  session: ImportSession,
  index: number,
  patch: Record<string, string>,
): ImportSession {
  const row = session.rows.find((item) => item.index === index)
  if (!row || row.state !== 'failed') {
    return session
  }
  row.values = { ...row.values, ...patch }
  const error = revalidateRow(row, session)
  if (error) {
    row.error = error
    persistSession(session)
    return session
  }
  row.error = ''
  row.state = 'pending'
  persistSession(session)
  return runFlowImport(session)
}

/** 跳过失败项，继续导入后面的条目。 */
export function skipFlowImportRow(session: ImportSession, index: number): ImportSession {
  const row = session.rows.find((item) => item.index === index)
  if (!row || row.state !== 'failed') {
    return session
  }
  row.state = 'skipped'
  persistSession(session)
  return runFlowImport(session)
}

export function isImportFinished(session: ImportSession): boolean {
  return session.rows.every((row) => row.state === 'committed' || row.state === 'skipped')
}

export function getImportSession(): ImportSession | null {
  if (typeof window === 'undefined' || !window.localStorage) {
    return null
  }
  const raw = window.localStorage.getItem(SESSION_KEY)
  if (!raw) {
    return null
  }
  try {
    return JSON.parse(raw) as ImportSession
  } catch {
    return null
  }
}

export function clearImportSession(): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.removeItem(SESSION_KEY)
  }
}

export function importCsvTemplate(): { filename: string; content: string } {
  const now = new Date()
  const today = now.toISOString().slice(0, 10)
  const sample: Record<string, string>[] = [
    {
      监测点编号: 'FLOW-1001',
      监测点位: '示例路与滨河路交汇井',
      监测时段: `${today} 08:00:00`,
      瞬时流量: '12.5',
      累计流量: '1024.0',
      水位标高: '3.20',
      流速: '0.85',
    },
  ]
  return {
    filename: '流量监测导入模板.csv',
    content: stringifyCsv([...FLOW_FIELDS], sample),
  }
}

/** 失败条目清单（CSV）：修正后重新上传即可继续导入。 */
export function failedRowsCsv(
  session: ImportSession,
): { filename: string; content: string } {
  const failed = session.rows.filter((row) => row.state === 'failed')
  const records = failed.map((row) => ({ ...row.values, 错误原因: row.error }))
  return {
    filename: `流量监测导入失败项-${session.fileName}`,
    content: stringifyCsv([...FLOW_FIELDS, '错误原因'], records),
  }
}

function matchPeriod(value: string, begin: string, end: string): boolean {
  if (!begin && !end) {
    return true
  }
  const time = parsePeriod(value)
  if (time === null) {
    return false
  }
  if (begin) {
    const beginTime = new Date(`${begin}T00:00:00`).getTime()
    if (time < beginTime) {
      return false
    }
  }
  if (end) {
    const endTime = new Date(`${end}T23:59:59`).getTime()
    if (time > endTime) {
      return false
    }
  }
  return true
}

/** 列表与导出共用同一过滤口径，保证条数始终一致。 */
export function listFlowEntries(query: Partial<FlowQuery> = {}): EntryRow[] {
  const keyword = (query.keyword ?? '').trim()
  const begin = (query.begin ?? '').trim()
  const end = (query.end ?? '').trim()

  return listRows(MODULE_KEY).filter((row) => {
    if (keyword) {
      const hit = ['监测点编号', '监测点位', '监测时段'].some((field) =>
        String(row[field] ?? '').includes(keyword),
      )
      if (!hit) {
        return false
      }
    }
    return matchPeriod(String(row['监测时段'] ?? ''), begin, end)
  })
}
