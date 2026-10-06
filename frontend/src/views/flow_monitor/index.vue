<template>
  <section class="page" data-module="flow_monitor">
    <header class="page-head">
      <div>
        <h2>流量监测管理</h2>
        <p class="page-desc">维护流量监测点，围绕监测点编号、监测点位、监测时段、瞬时流量做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openImport">上传数据文件</button>
        <button class="btn" type="button" @click="exportRows">导出当前清单</button>
      </div>
    </header>

    <div v-if="resumableSession" class="resume-banner">
      <span>
        上次上传「{{ resumableSession.fileName }}」已导入 {{ committedCount }}/{{ resumableSession.rows.length }} 条，
        还有 {{ failedCount }} 条失败项待处理，可从失败项继续，已导入条目不会丢失。
      </span>
      <span class="row-actions">
        <button class="link" type="button" @click="resumeImport">继续导入</button>
        <button class="link danger-link" type="button" @click="abandonSession">放弃本次导入</button>
      </span>
    </div>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label class="filter-item">
        <span>关键字</span>
        <input v-model="query.keyword" placeholder="按编号 / 点位 / 时段检索" />
      </label>
      <label class="filter-item">
        <span>监测时段起</span>
        <input v-model="query.begin" type="date" />
      </label>
      <label class="filter-item">
        <span>监测时段止</span>
        <input v-model="query.end" type="date" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button class="link" type="button" @click="openDetail(row)">查看详情</button>
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">当前过滤范围内暂无流量监测数据</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条流量监测记录（导出文件与此范围、条数一致）</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <div v-if="detailRow" class="modal-mask" @click.self="closeDetail">
      <div class="modal">
        <div class="modal-head">
          <h3>监测点详情 · {{ detailRow['监测点编号'] }}</h3>
          <button class="btn ghost" type="button" @click="closeDetail">关闭</button>
        </div>
        <div class="detail-status" :class="`status-${detailRow.status}`">
          当前在线状态：<strong>{{ detailRow.status }}</strong>
          <span v-if="detailRow.abnormal" class="detail-flag">异常标记</span>
        </div>
        <dl class="detail-grid">
          <template v-for="column in columns" :key="column">
            <dt>{{ column }}</dt>
            <dd>{{ detailRow[column] ?? '—' }}</dd>
          </template>
        </dl>
        <div class="modal-foot">
          <button
            v-for="action in actions"
            :key="action"
            class="btn"
            type="button"
            @click="runAction(action, detailRow)"
          >
            {{ action }}
          </button>
        </div>
      </div>
    </div>

    <div v-if="importOpen" class="modal-mask">
      <div class="modal modal-wide">
        <div class="modal-head">
          <h3>上传流量监测数据文件</h3>
          <button
            v-if="!session || isFinished"
            class="btn ghost"
            type="button"
            @click="closeImport"
          >
            关闭
          </button>
        </div>

        <div v-if="!session" class="import-pick">
          <p class="import-tip">
            仅支持 UTF-8 编码 CSV 文件，必填列：{{ requiredColumns.join('、') }}。<br />
            上传前会校验测点编号（FLOW- 开头加数字）、监测时段（不晚于当前时间）和指标范围；
            重复上传同一文件按测点编号更新已有记录，不新增监测点，原有在线/离线状态保留。
          </p>
          <ul class="range-list">
            <li v-for="metric in metricNames" :key="metric">
              {{ metric }}：{{ METRIC_RANGES[metric].min }} ~ {{ METRIC_RANGES[metric].max }}
            </li>
          </ul>
          <div class="row-actions">
            <label class="btn primary file-label">
              选择 CSV 文件
              <input class="file-input" type="file" accept=".csv,text/csv" @change="onFileChange" />
            </label>
            <button class="btn" type="button" @click="downloadTemplate">下载导入模板</button>
          </div>
          <p v-if="errorMessage" class="error-text import-error">{{ errorMessage }}</p>
        </div>

        <div v-else class="import-progress">
          <p class="import-tip">
            文件：{{ session.fileName }} ｜ 已完成 {{ committedCount }} 条
            <template v-if="updatedCount">（其中更新 {{ updatedCount }} 条）</template>
            ｜ 失败 {{ failedCount }} 条 ｜ 跳过 {{ skippedCount }} 条 ｜ 共 {{ session.rows.length }} 条
          </p>

          <div v-if="firstFailed" class="fix-panel">
            <p class="error-text">第 {{ firstFailed.index + 2 }} 行未通过：{{ firstFailed.error }}</p>
            <div class="form-grid">
              <label v-for="field in requiredColumns" :key="field" class="form-item">
                <span>{{ field }}</span>
                <input v-model="draft[field]" />
              </label>
            </div>
            <div class="row-actions">
              <button class="btn primary" type="button" @click="saveFix">保存并从本条继续</button>
              <button class="btn" type="button" @click="skipFailed">跳过本条继续</button>
              <button class="btn ghost" type="button" @click="downloadFailed">下载全部失败项</button>
              <button class="btn ghost danger-link" type="button" @click="abandonSession">终止导入（保留已导入）</button>
            </div>
          </div>

          <div v-else-if="isFinished" class="done-panel">
            <p>
              导入完成：成功 {{ committedCount }} 条<template v-if="updatedCount">（更新 {{ updatedCount }} 条）</template>，
              跳过 {{ skippedCount }} 条。
            </p>
            <button class="btn primary" type="button" @click="finishImport">完成并刷新列表</button>
          </div>

          <ul class="import-list">
            <li v-for="row in session.rows" :key="row.index" :class="`row-state-${row.state}`">
              <span class="state-tag">{{ stateLabel[row.state] }}</span>
              <span>第 {{ row.index + 2 }} 行 · {{ row.values['监测点编号'] }} · {{ row.values['监测点位'] }}</span>
              <span v-if="row.action === 'update'" class="action-tag">更新</span>
              <span v-else-if="row.action === 'create'" class="action-tag">新增</span>
              <span v-if="row.error" class="error-text row-error">{{ row.error }}</span>
            </li>
          </ul>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'

import { downloadFile, exportRows as buildExport, runAction as applyAction } from '@/api/local-service'
import {
  failedRowsCsv,
  fixFlowImportRow,
  FLOW_FIELDS,
  FLOW_METRICS,
  getImportSession,
  clearImportSession,
  importCsvTemplate,
  isImportFinished,
  listFlowEntries,
  METRIC_RANGES,
  prepareFlowImport,
  runFlowImport,
  skipFlowImportRow,
  type ImportRow,
  type ImportSession,
} from '@/data/flow-import'
import type { EntryRow } from '@/data/types'

const columns = ['监测点编号', '监测点位', '监测时段', '瞬时流量', '累计流量', '水位标高', '流速', '数据状态']
const actions = ['标记异常', '恢复在线', '申请校准']
const statuses = ['在线', '离线', '数据异常', '已校准']
const requiredColumns = [...FLOW_FIELDS]
const metricNames = [...FLOW_METRICS]

const stateLabel: Record<ImportRow['state'], string> = {
  pending: '待处理',
  committed: '已导入',
  failed: '失败',
  skipped: '已跳过',
}

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const query = reactive({ keyword: '', begin: '', end: '' })

const importOpen = ref(false)
const session = ref<ImportSession | null>(null)
const draft = ref<Record<string, string>>({})
const detailId = ref<number | null>(null)

const stats = computed(() => [
  { label: '在线测点', value: countStatus('在线') },
  { label: '离线测点', value: countStatus('离线') },
  { label: '异常测点', value: countStatus('数据异常') },
])

const statusSummary = computed(() =>
  statuses.map((status) => ({ status, count: countStatus(status) })),
)

function countStatus(status: string): number {
  return rows.value.filter((row) => String(row.status) === status).length
}

// 详情始终从当前列表数据读取：列表与详情同源，状态流转后不会出现对不上的情况。
const detailRow = computed<EntryRow | null>(() => {
  if (detailId.value === null) {
    return null
  }
  return rows.value.find((row) => Number(row.id) === detailId.value) ?? null
})

const firstFailed = computed(
  () => session.value?.rows.find((row) => row.state === 'failed') ?? null,
)

const isFinished = computed(() => (session.value ? isImportFinished(session.value) : false))
const committedCount = computed(
  () => session.value?.rows.filter((row) => row.state === 'committed').length ?? 0,
)
const failedCount = computed(
  () => session.value?.rows.filter((row) => row.state === 'failed').length ?? 0,
)
const skippedCount = computed(
  () => session.value?.rows.filter((row) => row.state === 'skipped').length ?? 0,
)
const updatedCount = computed(
  () => session.value?.rows.filter((row) => row.action === 'update').length ?? 0,
)

// 页面顶部的续传提示：只在存在未完成会话时出现。
const resumableSession = computed(() => {
  if (!session.value || importOpen.value || isImportFinished(session.value)) {
    return null
  }
  return session.value
})

watch(firstFailed, (row) => {
  draft.value = row ? { ...row.values } : {}
})

function resetFilters() {
  query.keyword = ''
  query.begin = ''
  query.end = ''
  reload()
}

function reload() {
  errorMessage.value = ''
  rows.value = listFlowEntries(query)
  total.value = rows.value.length
}

function exportRows() {
  // 导出直接复用列表的过滤结果与列：含水位标高、流速，条数与页面一致。
  const current = listFlowEntries(query)
  const suffix = query.begin || query.end ? `-${query.begin || '起始'}至${query.end || '至今'}` : ''
  const { filename, content } = buildExport('flow_monitor', current, columns, suffix)
  downloadFile(filename, content)
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction('flow_monitor', Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function openDetail(row: EntryRow) {
  detailId.value = Number(row.id)
}

function closeDetail() {
  detailId.value = null
}

function openImport() {
  errorMessage.value = ''
  importOpen.value = true
}

function closeImport() {
  importOpen.value = false
}

async function onFileChange(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) {
    return
  }
  errorMessage.value = ''
  let text: string
  try {
    text = await file.text()
  } catch {
    errorMessage.value = '文件读取失败，请重新选择'
    return
  }
  // 上传前整表校验：不通过则一条数据都不写入。
  const result = prepareFlowImport(file.name, text)
  if (!result.ok) {
    session.value = null
    errorMessage.value = result.message
    return
  }
  session.value = result.session
  advanceImport()
}

function advanceImport() {
  if (!session.value) {
    return
  }
  // 逐条提交并在每条后落盘会话：中断后已完成条目保留，可从失败项继续。
  runFlowImport(session.value)
  reload()
}

function resumeImport() {
  errorMessage.value = ''
  importOpen.value = true
  advanceImport()
}

function saveFix() {
  if (!session.value || !firstFailed.value) {
    return
  }
  fixFlowImportRow(session.value, firstFailed.value.index, draft.value)
  reload()
}

function skipFailed() {
  if (!session.value || !firstFailed.value) {
    return
  }
  skipFlowImportRow(session.value, firstFailed.value.index)
  reload()
}

function downloadFailed() {
  if (!session.value) {
    return
  }
  const { filename, content } = failedRowsCsv(session.value)
  downloadFile(filename, content)
}

function downloadTemplate() {
  const { filename, content } = importCsvTemplate()
  downloadFile(filename, content)
}

function abandonSession() {
  // 终止只清理导入会话：已提交的条目已经在业务数据里，不会回滚。
  clearImportSession()
  session.value = null
  importOpen.value = false
  reload()
}

function finishImport() {
  clearImportSession()
  session.value = null
  importOpen.value = false
  reload()
}

onMounted(() => {
  reload()
  const saved = getImportSession()
  if (saved && !isImportFinished(saved)) {
    session.value = saved
  }
})
</script>
