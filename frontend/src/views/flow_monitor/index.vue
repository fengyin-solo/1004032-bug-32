<template>
  <section class="page" data-module="flow_monitor">
    <header class="page-head">
      <div>
        <h2>流量监测管理</h2>
        <p class="page-desc">维护流量监测点，围绕监测点编号、监测点位、监测时段、瞬时流量做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记流量监测点</button>
        <button class="btn" type="button" :disabled="uploading" @click="triggerUpload">上传数据文件</button>
        <button class="btn" type="button" @click="exportRows">导出流量监测清单</button>
        <input ref="fileInput" type="file" accept=".csv,text/csv" hidden @change="onFileChange" />
      </div>
    </header>

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

    <div v-if="uploading || uploadMessage || failures.length" class="upload-panel">
      <p v-if="uploading" class="upload-progress">
        <span>正在上传 {{ uploadDone }}/{{ uploadTotal }} 条…</span>
        <button class="link" type="button" @click="abortUpload">中断上传</button>
      </p>
      <p v-if="uploadMessage" class="upload-message">{{ uploadMessage }}</p>
      <button
        v-if="!uploading && remainingRows.length"
        class="btn"
        type="button"
        @click="resumeUpload"
      >
        从失败项继续（剩余 {{ remainingRows.length }} 条）
      </button>
      <details v-if="failures.length" class="upload-failures">
        <summary>{{ failures.length }} 行未通过校验，未入库</summary>
        <ul>
          <li v-for="failure in failures" :key="failure.line">
            第 {{ failure.line }} 行：{{ failure.reason }}
          </li>
        </ul>
      </details>
    </div>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
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
          <td :colspan="columns.length + 2" class="empty-state">暂无流量监测数据，可先登记流量监测点</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条流量监测记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import { importValidRows, parseFlowFile } from '@/api/flow-upload'
import type { ImportOutcome, RowFailure, ValidRow } from '@/api/flow-upload'
import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('flow_monitor')
const columns = ["监测点编号", "监测点位", "监测时段", "瞬时流量", "累计流量", "水位标高", "流速", "数据状态"]
const actions = ["标记异常", "恢复在线", "申请校准"]
const statuses = ["在线", "离线", "数据异常", "已校准"]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)

function countStatus(status: string): number {
  return rows.value.filter((row) => String(row.status) === status).length
}

// 统计卡片跟着列表数据走，避免看板与清单对不上。
const stats = computed(() => [
  { label: '在线测点', value: countStatus('在线') },
  { label: '离线测点', value: countStatus('离线') },
  { label: '异常测点', value: countStatus('数据异常') },
])

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: countStatus(status),
  })),
)

const fileInput = ref<HTMLInputElement | null>(null)
const uploading = ref(false)
const uploadDone = ref(0)
const uploadTotal = ref(0)
const uploadMessage = ref('')
const failures = ref<RowFailure[]>([])
const remainingRows = ref<ValidRow[]>([])
let abortRequested = false

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  // 带上当前过滤条件，下载件条数与页面清单一致。
  downloadEntries(meta.key, filters.value)
}

function openCreate() {
  errorMessage.value = '流量监测点登记入口尚未接入审批流'
}

function triggerUpload() {
  if (uploading.value) {
    return
  }
  fileInput.value?.click()
}

async function onFileChange(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  // 清空选择，允许再次选择同一文件（重复文件只会更新已有记录）。
  input.value = ''
  if (!file) {
    return
  }
  uploadMessage.value = ''
  failures.value = []
  remainingRows.value = []
  let text = ''
  try {
    text = await file.text()
  } catch {
    uploadMessage.value = '文件读取失败，请重新选择'
    return
  }
  const parsed = parseFlowFile(text)
  if (parsed.headerError) {
    uploadMessage.value = `上传失败：${parsed.headerError}`
    return
  }
  failures.value = parsed.failures
  if (parsed.valid.length === 0) {
    uploadMessage.value = parsed.failures.length
      ? `没有可导入的有效条目，${parsed.failures.length} 行未通过校验`
      : '文件里没有数据行'
    return
  }
  await runImport(parsed.valid)
}

async function runImport(queue: ValidRow[]) {
  uploading.value = true
  abortRequested = false
  uploadDone.value = 0
  uploadTotal.value = queue.length
  const outcome = await importValidRows(
    queue,
    (done, totalCount) => {
      uploadDone.value = done
      uploadTotal.value = totalCount
    },
    () => abortRequested,
  )
  uploading.value = false
  remainingRows.value = outcome.remaining
  uploadMessage.value = describeOutcome(outcome)
  reload()
}

function describeOutcome(outcome: ImportOutcome): string {
  const summary = `新增 ${outcome.created} 条，更新 ${outcome.updated} 条`
  if (outcome.finished) {
    return `上传完成：${summary}`
  }
  return `上传已中断：已完成 ${outcome.done}/${outcome.total} 条（${summary}），剩余 ${outcome.remaining.length} 条可从失败项继续`
}

function abortUpload() {
  abortRequested = true
}

async function resumeUpload() {
  if (uploading.value || remainingRows.value.length === 0) {
    return
  }
  await runImport(remainingRows.value)
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '流量监测列表读取失败'
  }
}

onMounted(reload)
</script>
