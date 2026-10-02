<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import PreviewCanvas from '@/components/PreviewCanvas.vue'
import { store, state } from '@/logic/store'
import { PATTERN_LIBRARY, fetchPatternText } from '@/data/patterns'
import type { Contour, ContourWarning, OffsetMode, Pt, Shape } from '@/logic/types'
import type { ComputedShape } from '@/logic/pipeline'
import { makeContour } from '@/logic/cleanup'
import { dist, uid } from '@/logic/geometry'
import { arcToCubics, sampleCubicInto } from '@/logic/svg'

type Mode = 'outline' | 'toolpath' | 'bridge'
type Tool = 'select' | 'pan' | 'rect' | 'circle' | 'polygon' | 'bridge'
type SymOp = 'mirror_x' | 'mirror_y' | 'rotate_90' | 'rotate_180' | 'four_way'

const route = useRoute()
const router = useRouter()
const canvas = ref<InstanceType<typeof PreviewCanvas> | null>(null)

const projectId = computed(() => String(route.params.id))
const project = computed(() => store.getProject(projectId.value) ?? null)

const tool = ref<Tool>('select')
const mode = ref<Mode>('outline')
const selectedShapeId = ref<string>('')
const selectedContourId = ref<string | null>(null)
const cursorPt = ref<Pt>({ x: 0, y: 0 })
const busy = ref('')
const error = ref('')
const showProblems = ref(true)
const showRules = ref(true)
const showContour = ref(true)
const showPending = ref(true)
const showOffsetList = ref(false)
const showOffsetBadges = ref(true)

watch(
  project,
  (p) => {
    if (p && p.shapes.length > 0 && !p.shapes.some((s) => s.id === selectedShapeId.value)) {
      selectedShapeId.value = p.shapes[0].id
    }
    if (p && !p.batchShapeId && p.shapes.length > 0) p.batchShapeId = p.shapes[0].id
  },
  { immediate: true },
)

const shapes = computed(() => project.value?.shapes ?? [])
const selectedShape = computed(() => shapes.value.find((s) => s.id === selectedShapeId.value) ?? null)
const selectedContour = computed<Contour | null>(() => {
  if (!selectedContourId.value) return null
  for (const s of shapes.value) {
    const c = s.contours.find((x) => x.id === selectedContourId.value)
    if (c) return c
  }
  return null
})

const computedOfSelected = computed(() => {
  if (!selectedShape.value) return null
  return store.computedOf(selectedShape.value.id)
})

const totalStats = computed(() => {
  let contours = 0
  let closed = 0
  let open = 0
  let bridges = 0
  let cutLen = 0
  let travel = 0
  let naive = 0
  let ms = 0
  let fragments = 0
  let maxDepth = 1
  let dev = 0
  let netArea = 0
  let cutNetArea = 0
  let pending = 0
  for (const s of shapes.value) {
    const c = store.computedOf(s.id)
    if (!c) continue
    contours += c.stats.contourCount
    closed += c.stats.closedCount
    open += c.stats.openCount
    bridges += c.stats.bridgeCount
    fragments += c.stats.fragmentCount
    cutLen += c.stats.cutLengthMm
    travel += c.stats.travelMm
    naive += c.stats.naiveTravelMm
    ms += c.elapsedMs
    maxDepth = Math.max(maxDepth, c.stats.maxDepth)
    dev = Math.max(dev, c.stats.geometryDeviationMm)
    netArea += c.stats.netAreaMm2
    cutNetArea += c.stats.cutNetAreaMm2
    pending += c.stats.offsetPending
  }
  return {
    contours,
    closed,
    open,
    bridges,
    fragments,
    cutLen,
    travel,
    naive,
    ms,
    maxDepth,
    dev,
    netArea,
    cutNetArea,
    pending,
    improve: naive > 1e-9 ? ((naive - travel) / naive) * 100 : 0,
  }
})

type Problem = { id: string; shapeId: string; contourId: string; kind: ContourWarning; text: string; level: 'err' | 'warn' | 'info' }

const problems = computed<Problem[]>(() => {
  const out: Problem[] = []
  for (const s of shapes.value) {
    const comp = store.computedOf(s.id)
    for (const c of s.contours) {
      for (const w of c.warnings) {
        if (w === 'not_closed') {
          const gap = c.points.length >= 2 ? dist(c.points[0], c.points[c.points.length - 1]) : 0
          out.push({
            id: `${c.id}-nc`,
            shapeId: s.id,
            contourId: c.id,
            kind: w,
            text: `未闭合：首尾相距 ${gap.toFixed(2)}mm（容差 ${project.value?.settings.closeToleranceMm}mm），切不穿`,
            level: 'err',
          })
        } else if (w === 'self_intersect') {
          out.push({
            id: `${c.id}-si`,
            shapeId: s.id,
            contourId: c.id,
            kind: w,
            text: `自交：路径与自身相交，交点处切不干净`,
            level: 'err',
          })
        } else if (w === 'duplicate') {
          out.push({ id: `${c.id}-dp`, shapeId: s.id, contourId: c.id, kind: w, text: '重复路径：存在完全重叠/反向重叠的路径，已合并只切一次', level: 'warn' })
        } else if (w === 'offset_pending') {
          out.push({ id: `${c.id}-op`, shapeId: s.id, contourId: c.id, kind: w, text: comp?.byId.get(c.id)?.offsetMessage || '刀补偏置失败，已按原路径出图', level: 'err' })
        } else if (w === 'offset_failed') {
          out.push({ id: `${c.id}-of`, shapeId: s.id, contourId: c.id, kind: w, text: comp?.byId.get(c.id)?.offsetMessage || '刀补偏置失败，已保留原路径', level: 'err' })
        } else if (w === 'offset_reduced') {
          out.push({ id: `${c.id}-or`, shapeId: s.id, contourId: c.id, kind: w, text: comp?.byId.get(c.id)?.offsetMessage || '刀补已缩小一半重试', level: 'warn' })
        } else if (w === 'offset_clipped') {
          out.push({ id: `${c.id}-oc`, shapeId: s.id, contourId: c.id, kind: w, text: comp?.byId.get(c.id)?.offsetMessage || '刀补在凹角产生自交，已裁剪', level: 'info' })
        } else if (w === 'bridge_degraded') {
          out.push({
            id: `${c.id}-bd`,
            shapeId: s.id,
            contourId: c.id,
            kind: w,
            text: comp?.byId.get(c.id)?.bridgeMetrics.reason || '轮廓过短，连刀点宽度已削窄',
            level: 'warn',
          })
        }
      }
    }
  }
  return out
})

function locate(p: Problem): void {
  selectedShapeId.value = p.shapeId
  selectedContourId.value = p.contourId
  canvas.value?.focusContour(p.contourId)
}

function onSelectContour(id: string, shapeId: string): void {
  selectedContourId.value = id
  selectedShapeId.value = shapeId
}

function mutate(fn: () => void): void {
  const p = project.value
  if (!p) return
  fn()
  store.recomputeProject(p, true)
  store.touch(p)
}

function drawingTargetShape(): Shape {
  const p = project.value as NonNullable<typeof project.value>
  const cur = selectedShape.value
  if (cur && cur.name.startsWith('绘图')) return cur
  const s: Shape = { id: uid('s'), name: `绘图 ${p.shapes.filter((x) => x.name.startsWith('绘图')).length + 1}`, contours: [], layer: cur?.layer ?? 0 }
  p.shapes.push(s)
  selectedShapeId.value = s.id
  return s
}

function onRect(r: { x: number; y: number; w: number; h: number }): void {
  mutate(() => {
    const s = drawingTargetShape()
    s.contours.push(
      makeContour(
        [
          { x: r.x, y: r.y },
          { x: r.x + r.w, y: r.y },
          { x: r.x + r.w, y: r.y + r.h },
          { x: r.x, y: r.y + r.h },
        ],
        true,
      ),
    )
  })
}

function circlePoints(cx: number, cy: number, r: number, tol = 0.1): Pt[] {
  const pts: Pt[] = []
  const cubics = [...arcToCubics(cx + r, cy, r, r, 0, true, true, cx - r, cy), ...arcToCubics(cx - r, cy, r, r, 0, true, true, cx + r, cy)]
  let cur: Pt = { x: cx + r, y: cy }
  for (const [c1, c2, end] of cubics) {
    sampleCubicInto(cur, c1, c2, end, tol, pts)
    cur = end
  }
  return pts
}

function onCircle(c: { cx: number; cy: number; r: number }): void {
  mutate(() => {
    const s = drawingTargetShape()
    s.contours.push(makeContour(circlePoints(c.cx, c.cy, c.r), true))
  })
}

function onPolygon(p: Pt[]): void {
  mutate(() => {
    const s = drawingTargetShape()
    s.contours.push(makeContour(p, true))
  })
}

function onManualBridge(b: { contourId: string; atIndex: number }): void {
  const p = project.value
  if (!p) return
  store.placeManualBridge(p, b.contourId, b.atIndex)
}

async function addPattern(slug: string): Promise<void> {
  const p = project.value
  if (!p || !slug) return
  const entry = PATTERN_LIBRARY.find((x) => x.slug === slug)
  if (!entry) return
  busy.value = slug
  error.value = ''
  try {
    const text = await fetchPatternText(entry.file)
    const { shape } = store.importSvgToShapes(text, entry.name, p.settings)
    shape.layer = selectedShape.value?.layer ?? 0
    store.addShape(p, shape)
    selectedShapeId.value = shape.id
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    busy.value = ''
  }
}

function applySym(op: SymOp): void {
  const p = project.value
  if (!p || !selectedShape.value) return
  store.applySymmetry(p, selectedShape.value.id, op)
}

function closeAll(): void {
  const p = project.value
  if (!p) return
  const n = store.closeAllOpen(p)
  error.value = n === 0 ? '没有可闭合的轮廓' : ''
}

function closeOne(): void {
  const p = project.value
  if (!p || !selectedContour.value) return
  if (!store.closeContour(p, selectedContour.value.id)) error.value = '该轮廓已闭合或点数不足（≥3 点才能闭合）'
  else error.value = ''
}

function delContour(): void {
  const p = project.value
  if (!p || !selectedContour.value) return
  store.removeContour(p, selectedContour.value.id)
  selectedContourId.value = null
}

function delShape(): void {
  const p = project.value
  if (!p || !selectedShape.value) return
  if (!confirm(`删除形状「${selectedShape.value.name}」？`)) return
  store.removeShape(p, selectedShape.value.id)
  selectedContourId.value = null
}

function setName(v: string): void {
  const p = project.value
  if (!p) return
  if (selectedShape.value) {
    selectedShape.value.name = v
    store.touch(p)
  } else {
    p.name = v
    store.touch(p)
  }
}

function addLayer(): void {
  const p = project.value
  if (!p) return
  const max = Math.max(...p.shapes.map((s) => s.layer), 0)
  if (selectedShape.value) {
    selectedShape.value.layer = max + 1
    store.recomputeProject(p, true)
    store.touch(p)
  }
}

const rule = computed(() => project.value?.settings.bridgeRule ?? 'by_area')
const settings = computed(() => project.value?.settings)

function patch(mut: (s: NonNullable<typeof settings.value>) => void): void {
  const p = project.value
  if (!p) return
  mut(p.settings)
  store.updateSettings(p, {})
}

const selMetrics = computed(() => {
  const c = selectedContour.value
  if (!c) return null
  const comp = computedOfSelected.value
  const m = comp?.byId.get(c.id)
  return m ?? null
})

const computedMap = computed(() => {
  const m = new Map<string, ComputedShape>()
  for (const s of shapes.value) {
    const c = store.computedOf(s.id)
    if (c) m.set(s.id, c)
  }
  return m
})

// ---------------- 刀补：档位 / 待处理 / 重算对照 ----------------

const materialDefault = computed(() => (project.value ? store.materialOf(project.value)?.bladeOffsetMm ?? 0 : 0))

function offsetModeOf(c: Contour): OffsetMode {
  return c.offsetCfg?.mode ?? 'material'
}

/** 档位显示：跟材料 0.25 / 自定义 0.1 / 不偏（总开关关闭时跟材料显示为 0） */
function offsetLabel(c: Contour): string {
  const p = project.value
  if (!p) return ''
  const mode = offsetModeOf(c)
  if (mode === 'off') return '不偏'
  if (mode === 'custom') return `自定义 ${(c.offsetCfg?.customMm ?? 0).toFixed(2)}`
  return p.settings.useBladeOffset ? `跟材料 ${materialDefault.value.toFixed(2)}` : '跟材料(关)'
}

type PendingItem = {
  contourId: string
  shapeId: string
  shapeName: string
  contour: Contour
  message: string
  requestedMm: number
}

/** 待处理清单：偏置失败、已按原路径出图的轮廓 */
const pendingItems = computed<PendingItem[]>(() => {
  const out: PendingItem[] = []
  for (const s of shapes.value) {
    const comp = store.computedOf(s.id)
    if (!comp) continue
    for (const c of s.contours) {
      const e = comp.byId.get(c.id)
      if (e?.offset.failed) {
        out.push({
          contourId: c.id,
          shapeId: s.id,
          shapeName: s.name,
          contour: c,
          message: e.offsetMessage,
          requestedMm: e.offset.requestedMm,
        })
      }
    }
  }
  return out
})

type ContourRow = {
  shapeId: string
  shapeName: string
  contour: Contour
  depth: number
  label: string
  applied: string
  status: 'ok' | 'clipped' | 'reduced' | 'off' | 'failed'
}

/** 全部轮廓的刀补一览（看每条当前用的是哪一档 + 实际生效量） */
const contourRows = computed<ContourRow[]>(() => {
  const out: ContourRow[] = []
  for (const s of shapes.value) {
    const comp = store.computedOf(s.id)
    for (const c of s.contours) {
      const e = comp?.byId.get(c.id)
      const st = e?.offset
      let status: ContourRow['status'] = 'ok'
      if (!c.closed) status = 'off'
      else if (st?.failed) status = 'failed'
      else if (st?.retried) status = 'reduced'
      else if (st?.clipped) status = 'clipped'
      else if (!st || st.appliedMm < 1e-9) status = 'off'
      out.push({
        shapeId: s.id,
        shapeName: s.name,
        contour: c,
        depth: comp?.tree.depthOf.get(c.id) ?? 1,
        label: offsetLabel(c),
        applied: !c.closed ? '—' : st ? `${st.appliedMm.toFixed(2)}mm` : '—',
        status,
      })
    }
  }
  return out
})

function rowClass(r: ContourRow): string {
  return { ok: '', clipped: 'info', reduced: 'warn', off: 'mute', failed: 'err' }[r.status]
}

function locateContour(shapeId: string, contourId: string): void {
  selectedShapeId.value = shapeId
  selectedContourId.value = contourId
  canvas.value?.focusContour(contourId)
}

function setOffsetMode(mode: OffsetMode): void {
  const p = project.value
  const c = selectedContour.value
  if (!p || !c) return
  store.setContourOffset(p, c.id, mode)
}

function setCustomMm(v: number): void {
  const p = project.value
  const c = selectedContour.value
  if (!p || !c || !Number.isFinite(v)) return
  store.setContourOffset(p, c.id, 'custom', Math.max(0.01, v))
}

function retryReduced(item: PendingItem): void {
  const p = project.value
  if (!p) return
  store.retryContourOffsetReduced(p, item.contourId)
}

function keepOriginal(item: PendingItem): void {
  const p = project.value
  if (!p) return
  store.setContourOffsetOff(p, item.contourId)
}

function allKeepOriginal(): void {
  const p = project.value
  if (!p) return
  const n = store.resolveAllPendingAsOff(p)
  if (n === 0) error.value = '待处理清单已空'
  else error.value = ''
}

// ---------------- 重算对照（钉住基线，刷新后看差异） ----------------

type Baseline = { cutLen: number; cutNetArea: number; pending: number; bridges: number; at: string }
const baseline = ref<Baseline | null>(null)

function pinBaseline(): void {
  baseline.value = {
    cutLen: totalStats.value.cutLen,
    cutNetArea: totalStats.value.cutNetArea,
    pending: totalStats.value.pending,
    bridges: totalStats.value.bridges,
    at: new Date().toLocaleTimeString(),
  }
}

function clearBaseline(): void {
  baseline.value = null
}

function fmtDelta(v: number, digits = 1, unit = ''): string {
  if (Math.abs(v) < 0.5 * 10 ** -digits) return '±0'
  return `${v > 0 ? '+' : '−'}${Math.abs(v).toFixed(digits)}${unit}`
}
</script>

<template>
  <div v-if="!project" class="splash">项目不存在，请返回纹样库 <RouterLink to="/">返回</RouterLink></div>
  <div v-else class="workbench">
    <!-- 左：工具栏 -->
    <div class="panel">
      <div class="panel-head">工具</div>
      <div class="panel-body">
        <div class="tool-group">
          <button class="tool" :class="{ active: tool === 'select' }" @click="tool = 'select'"><span class="tool-icon">▶</span>选择 / 点选轮廓</button>
          <button class="tool" :class="{ active: tool === 'pan' }" @click="tool = 'pan'"><span class="tool-icon">✥</span>平移画布</button>
          <button class="tool" :class="{ active: tool === 'rect' }" @click="tool = 'rect'"><span class="tool-icon">▭</span>矩形</button>
          <button class="tool" :class="{ active: tool === 'circle' }" @click="tool = 'circle'"><span class="tool-icon">○</span>圆形</button>
          <button class="tool" :class="{ active: tool === 'polygon' }" @click="tool = 'polygon'"><span class="tool-icon">△</span>多边形</button>
          <button class="tool" :class="{ active: tool === 'bridge' }" @click="tool = 'bridge'"><span class="tool-icon">⌇</span>手工放连刀点</button>
        </div>
        <div class="hint">矩形/圆形：按住拖动绘制；多边形：逐点点击，回车或双击完成；手工连刀点：点击轮廓上的位置。</div>

        <div class="section">
          <div class="section-title">添加纹样</div>
          <select :value="''" @change="addPattern(($event.target as HTMLSelectElement).value)">
            <option value="">从内置纹样库添加…</option>
            <option v-for="p in PATTERN_LIBRARY" :key="p.slug" :value="p.slug">{{ p.category }}｜{{ p.name }}</option>
          </select>
          <div v-if="busy" class="hint">解析中…</div>
        </div>

        <div class="section">
          <div class="section-title">对称生成（选中形状）</div>
          <div class="btn-row">
            <button class="tiny" @click="applySym('mirror_x')">左右镜像</button>
            <button class="tiny" @click="applySym('mirror_y')">上下镜像</button>
            <button class="tiny" @click="applySym('rotate_90')">旋转 90°</button>
            <button class="tiny" @click="applySym('rotate_180')">旋转 180°</button>
            <button class="tiny" @click="applySym('four_way')">四方连续</button>
          </div>
        </div>

        <div class="section">
          <div class="section-title">图形列表</div>
          <div class="list">
            <div
              v-for="s in shapes"
              :key="s.id"
              class="list-item"
              :class="{ active: s.id === selectedShapeId }"
              @click="selectedShapeId = s.id"
            >
              <span class="grow">{{ s.name }}</span>
              <span class="tag">L{{ s.layer + 1 }}</span>
              <span class="tag">{{ s.contours.length }}</span>
            </div>
          </div>
          <div class="btn-row" style="margin-top: 6px">
            <button class="tiny" @click="delShape" :disabled="!selectedShape">删除形状</button>
            <button class="tiny" @click="addLayer" :disabled="!selectedShape">移到新图层</button>
          </div>
        </div>

        <div class="section">
          <div class="section-title">项目</div>
          <div class="field">
            <label>项目名</label>
            <input type="text" :value="project.name" @input="setName(($event.target as HTMLInputElement).value)" />
          </div>
          <div class="btn-row">
            <button class="tiny" @click="router.push(`/layout/${project.id}`)">进入排版</button>
            <button class="tiny" @click="router.push(`/export/${project.id}`)">进入导出</button>
          </div>
        </div>
      </div>
    </div>

    <!-- 中：预览 -->
    <div class="panel canvas-panel">
      <div class="panel-head">
        <div class="mode-switch">
          <button :class="{ active: mode === 'outline' }" @click="mode = 'outline'">成品轮廓</button>
          <button :class="{ active: mode === 'toolpath' }" @click="mode = 'toolpath'">刀路 · 顺序</button>
          <button :class="{ active: mode === 'bridge' }" @click="mode = 'bridge'">连刀点放大 ×8</button>
        </div>
        <span class="spacer"></span>
        <span class="tag mono">光标 {{ cursorPt.x }}, {{ cursorPt.y }} mm</span>
      </div>
      <PreviewCanvas
        ref="canvas"
        :shapes="shapes"
        :computed="computedMap"
        :mode="mode"
        :tool="tool"
        :show-numbers="mode === 'toolpath'"
        :show-travel="mode === 'toolpath'"
        :magnify="true"
        :selected-contour-id="selectedContourId"
        :show-offset-badges="showOffsetBadges"
        :status-text="mode === 'bridge' ? '缺口已放大 8 倍' : ''"
        @select-contour="onSelectContour"
        @create-rect="onRect"
        @create-circle="onCircle"
        @create-polygon="onPolygon"
        @manual-bridge="onManualBridge"
        @cursor="cursorPt = $event"
      />
      <div class="panel-foot">
        <div class="legend">
          <span v-if="mode === 'outline'"><i style="background: #cfd9e4"></i>轮廓</span>
          <span><i style="background: #ffc857"></i>未闭合</span>
          <span><i style="background: #ff6b6b"></i>自交/刀补失败</span>
          <span><i style="background: #b48cff"></i>重复路径</span>
          <span v-if="mode === 'outline' && showOffsetBadges"><i style="background: #6db8ff"></i>M 跟材料</span>
          <span v-if="mode === 'outline' && showOffsetBadges"><i style="background: #ffd166"></i>C 指定量（黄=裁剪/橙=缩小）</span>
          <span v-if="mode === 'toolpath'"><i style="background: #ff8f3c"></i>刀路</span>
          <span v-if="mode === 'toolpath'"><i style="background: #7f8fa3"></i>跳刀</span>
          <span v-if="mode === 'bridge'"><i style="background: #47c07a"></i>连刀点缺口</span>
        </div>
      </div>
    </div>

    <!-- 右：属性与规则 -->
    <div class="panel">
      <div class="panel-head">属性与规则</div>
      <div class="panel-body">
        <div v-if="error" class="banner err">{{ error }}</div>

        <div class="stat-grid">
          <div class="stat"><div class="k">轮廓 / 闭合</div><div class="v">{{ totalStats.contours }}<small>/{{ totalStats.closed }}</small></div></div>
          <div class="stat"><div class="k">未闭合</div><div class="v" :style="{ color: totalStats.open ? 'var(--err)' : '' }">{{ totalStats.open }}</div></div>
          <div class="stat"><div class="k">连刀点</div><div class="v">{{ totalStats.bridges }}</div></div>
          <div class="stat"><div class="k">刀路总长</div><div class="v">{{ totalStats.cutLen.toFixed(0) }}<small>mm</small><span v-if="baseline" class="delta" :class="totalStats.cutLen - baseline.cutLen >= 0 ? 'up' : 'down'">{{ fmtDelta(totalStats.cutLen - baseline.cutLen, 0) }}</span></div></div>
          <div class="stat"><div class="k">跳刀 / 优化</div><div class="v">{{ totalStats.travel.toFixed(0) }}<small>mm · {{ totalStats.improve >= 0 ? '−' : '+' }}{{ Math.abs(totalStats.improve).toFixed(1) }}%</small></div></div>
          <div class="stat"><div class="k">嵌套层数</div><div class="v">{{ totalStats.maxDepth }}</div></div>
          <div class="stat"><div class="k">成品净面积</div><div class="v">{{ totalStats.netArea.toFixed(0) }}<small>mm²</small></div></div>
          <div class="stat">
            <div class="k">切出净面积(刀补后)</div>
            <div class="v" :style="{ color: Math.abs(totalStats.cutNetArea - totalStats.netArea) > 0.5 ? '#ffb066' : '' }">
              {{ totalStats.cutNetArea.toFixed(0) }}<small>mm²</small>
              <span v-if="baseline" class="delta" :class="totalStats.cutNetArea - baseline.cutNetArea >= 0 ? 'up' : 'down'">{{ fmtDelta(totalStats.cutNetArea - baseline.cutNetArea, 0) }}</span>
            </div>
          </div>
          <div class="stat"><div class="k">刀补待处理</div><div class="v" :style="{ color: totalStats.pending ? 'var(--err)' : '' }">{{ totalStats.pending }}<span v-if="baseline && totalStats.pending !== baseline.pending" class="delta" :class="totalStats.pending - baseline.pending > 0 ? 'up' : 'down'">{{ fmtDelta(totalStats.pending - baseline.pending, 0) }}</span></div></div>
          <div class="stat"><div class="k">几何偏差</div><div class="v">{{ totalStats.dev.toFixed(3) }}<small>mm</small></div></div>
          <div class="stat"><div class="k">计算耗时</div><div class="v">{{ totalStats.ms.toFixed(1) }}<small>ms</small></div></div>
        </div>

        <div class="section">
          <div class="section-title" @click="showProblems = !showProblems">
            问题清单
            <span class="tag" :class="problems.length ? 'err' : 'ok'">{{ problems.length }}</span>
            <span class="spacer"></span>
            <button class="tiny" @click.stop="closeAll">一键闭合未闭合轮廓</button>
          </div>
          <div v-show="showProblems">
            <div v-if="problems.length === 0" class="empty">未发现问题：路径闭合、无自交、无重复。</div>
            <div class="list">
              <div v-for="p in problems" :key="p.id" class="list-item" @click="locate(p)">
                <span class="tag" :class="p.level === 'err' ? 'err' : p.level === 'warn' ? 'warn' : 'info'">{{ p.kind }}</span>
                <span class="grow">{{ p.text }}</span>
              </div>
            </div>
          </div>
        </div>

        <div class="section">
          <div class="section-title" @click="showPending = !showPending">
            刀补待处理
            <span class="tag" :class="pendingItems.length ? 'err' : 'ok'">{{ pendingItems.length }}</span>
            <span class="spacer"></span>
            <button class="tiny" :disabled="pendingItems.length === 0" @click.stop="allKeepOriginal">全部按原路径</button>
          </div>
          <div v-show="showPending">
            <div v-if="pendingItems.length === 0" class="empty">没有偏置失败的轮廓：刀补全部可用或已处理完。</div>
            <div class="list">
              <div v-for="it in pendingItems" :key="`pend-${it.contourId}`" class="list-item pending-row">
                <div class="grow" @click="locateContour(it.shapeId, it.contourId)">
                  <div><span class="tag err">{{ it.shapeName }}</span> {{ it.message }}</div>
                  <div class="hint mono">原请求偏置 {{ it.requestedMm.toFixed(2) }}mm → 缩小一半 ≈ {{ Math.max(0.02, it.requestedMm * 0.5).toFixed(2) }}mm</div>
                </div>
                <div class="pending-actions">
                  <button class="tiny" title="改为按一半偏置量重算这一条" @click.stop="retryReduced(it)">缩小重试</button>
                  <button class="tiny" title="这条不再偏置，按原路径出图" @click.stop="keepOriginal(it)">原路径</button>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div class="section">
          <div class="section-title" @click="showContour = !showContour">
            选中轮廓
            <span class="spacer"></span>
            <button class="tiny" :disabled="!selectedContour" @click.stop="closeOne">闭合</button>
            <button class="tiny danger" :disabled="!selectedContour" @click.stop="delContour">删除</button>
          </div>
          <div v-show="showContour">
            <div v-if="!selectedContour" class="empty">在画布上点选一条轮廓</div>
            <template v-else>
              <div class="stat-grid">
                <div class="stat"><div class="k">点数</div><div class="v">{{ selectedContour.points.length }}</div></div>
                <div class="stat"><div class="k">面积</div><div class="v">{{ selectedContour.area.toFixed(2) }}<small>mm²</small></div></div>
                <div class="stat"><div class="k">周长</div><div class="v">{{ selectedContour.length.toFixed(2) }}<small>mm</small></div></div>
                <div class="stat"><div class="k">状态</div><div class="v" style="font-size: 12px">{{ selectedContour.closed ? '已闭合' : '未闭合' }}</div></div>
                <div class="stat"><div class="k">内层数</div><div class="v">{{ selectedContour.holes.length }}</div></div>
                <div class="stat"><div class="k">连刀点</div><div class="v">{{ selMetrics?.anchors.length ?? 0 }}</div></div>
              </div>
              <div v-if="selMetrics" class="hint" style="margin-top: 6px">
                {{ selMetrics.bridgeMetrics.reason }}｜几何偏差 {{ selMetrics.bridgeMetrics.geometryDeviationMm.toFixed(3) }}mm
              </div>

              <div class="offset-box">
                <div class="offset-title">刀补档位
                  <span class="spacer"></span>
                  <span class="tag" :class="selMetrics ? (selMetrics.offset.failed ? 'err' : selMetrics.offset.retried ? 'warn' : selMetrics.offset.appliedMm > 1e-9 ? 'ok' : 'mute') : ''">
                    当前：{{ !selectedContour.closed ? '开口不偏' : selMetrics?.offset.failed ? '失败·原路径' : (selMetrics?.offset.appliedMm ?? 0) > 1e-9 ? `生效 ${selMetrics!.offset.appliedMm.toFixed(2)}mm` : '不偏' }}
                  </span>
                </div>
                <div class="seg">
                  <button :class="{ active: offsetModeOf(selectedContour) === 'material' }" @click="setOffsetMode('material')">跟材料走</button>
                  <button :class="{ active: offsetModeOf(selectedContour) === 'custom' }" @click="setOffsetMode('custom')">按指定量</button>
                  <button :class="{ active: offsetModeOf(selectedContour) === 'off' }" @click="setOffsetMode('off')">不偏</button>
                </div>
                <div v-if="offsetModeOf(selectedContour) === 'custom'" class="field-row">
                  <label>偏置量</label>
                  <input
                    type="number"
                    step="0.01"
                    min="0.01"
                    :value="selectedContour.offsetCfg?.customMm ?? 0.2"
                    @change="setCustomMm(Number(($event.target as HTMLInputElement).value))"
                  />
                  <span class="hint">mm（外/内层方向自动）</span>
                </div>
                <div class="hint" v-if="offsetModeOf(selectedContour) === 'material'">
                  材料「{{ store.materialOf(project)?.name }}」刀偏 {{ materialDefault.toFixed(2) }}mm，{{ settings?.useBladeOffset ? '总开关已开：本条按该量偏置' : '总开关关闭：本条当前不偏' }}
                </div>
                <div v-if="selMetrics && selMetrics.offsetMessage" class="hint" :class="selMetrics.offset.failed ? 'err-text' : ''">{{ selMetrics.offsetMessage }}</div>
              </div>

              <div v-if="selMetrics && selMetrics.anchors.length" class="bridge-list">
                <div v-for="(b, i) in selMetrics.anchors.slice(0, 30)" :key="i" class="mono">
                  #{{ i + 1 }} 锚点 ({{ b.at.x.toFixed(2) }}, {{ b.at.y.toFixed(2) }})｜宽 {{ b.widthMm.toFixed(3) }}mm
                </div>
              </div>
            </template>
          </div>
        </div>

        <div class="section" v-if="settings">
          <div class="section-title" @click="showRules = !showRules">切割规则</div>
          <div v-show="showRules">
            <div class="field-row">
              <label>连刀规则</label>
              <select :value="settings.bridgeRule" @change="patch((s) => (s.bridgeRule = ($event.target as HTMLSelectElement).value as never))">
                <option value="by_area">按片段面积（碎片必连刀）</option>
                <option value="by_length">按轮廓长度（每 L mm）</option>
                <option value="manual">手工放置</option>
              </select>
            </div>
            <div class="field-row">
              <label>面积阈值</label>
              <input type="number" step="0.5" min="0" :value="settings.areaThresholdMm2" @change="patch((s) => (s.areaThresholdMm2 = Number(($event.target as HTMLInputElement).value)))" />
              <span class="hint">mm²</span>
            </div>
            <div class="field-row">
              <label>缺口宽度</label>
              <input type="number" step="0.05" min="0.1" max="2" :value="settings.bridgeWidthMm" @change="patch((s) => (s.bridgeWidthMm = Number(($event.target as HTMLInputElement).value)))" />
              <span class="hint">mm</span>
            </div>
            <div class="field-row">
              <label>每 L 一个</label>
              <input type="number" step="1" min="1" :value="settings.bridgeEveryMm" @change="patch((s) => (s.bridgeEveryMm = Number(($event.target as HTMLInputElement).value)))" />
              <span class="hint">mm</span>
            </div>
            <div class="field-row">
              <label>跳刀优化</label>
              <select :value="settings.travelOptimize" @change="patch((s) => (s.travelOptimize = ($event.target as HTMLSelectElement).value as never))">
                <option value="nearest_2opt">最近邻 + 2-opt</option>
                <option value="nearest">仅最近邻</option>
              </select>
            </div>
            <div class="field-row">
              <label>曲线容差</label>
              <input type="number" step="0.05" min="0.02" :value="settings.toleranceMm" @change="patch((s) => (s.toleranceMm = Number(($event.target as HTMLInputElement).value)))" />
              <span class="hint">mm</span>
            </div>
            <div class="field-row">
              <label>闭合容差</label>
              <input type="number" step="0.05" min="0.01" :value="settings.closeToleranceMm" @change="patch((s) => (s.closeToleranceMm = Number(($event.target as HTMLInputElement).value)))" />
              <span class="hint">mm</span>
            </div>
            <label class="check"><input type="checkbox" :checked="settings.useBladeOffset" @change="patch((s) => (s.useBladeOffset = ($event.target as HTMLInputElement).checked))" /> 刀补总开关：「跟材料走」的轮廓按材料刀偏偏置（外外内内；凹角自交自动裁剪）</label>
            <div class="field-row">
              <label>偏置失败时</label>
              <select :value="settings.offsetFailPolicy" @change="patch((s) => (s.offsetFailPolicy = ($event.target as HTMLSelectElement).value as never))">
                <option value="retry_halved">缩小一半自动重试一次</option>
                <option value="passthrough">原路径出图，进待处理清单</option>
              </select>
            </div>
            <label class="check"><input type="checkbox" v-model="showOffsetBadges" /> 画布上标出每条轮廓的刀补档位角标</label>

            <div class="offset-list-head" @click="showOffsetList = !showOffsetList">
              <span class="section-title" style="display: inline">各轮廓刀补一览（{{ contourRows.length }} 条）</span>
              <span class="spacer"></span>
              <span class="hint">{{ contourRows.filter((r) => r.status === 'failed').length }} 待处理 / {{ contourRows.filter((r) => r.status === 'reduced').length }} 缩小 / {{ contourRows.filter((r) => r.status === 'clipped').length }} 裁剪</span>
            </div>
            <div v-show="showOffsetList" class="offset-list">
              <div v-for="r in contourRows" :key="r.contour.id" class="offset-row" :class="rowClass(r)" @click="locateContour(r.shapeId, r.contour.id)">
                <span class="tag mute">L{{ r.depth }}</span>
                <span class="grow">{{ r.shapeName }} · {{ r.contour.closed ? '闭合' : '开口' }} {{ r.contour.area.toFixed(1) }}mm²</span>
                <span class="tag" :class="r.status === 'failed' ? 'err' : r.status === 'reduced' ? 'warn' : r.status === 'clipped' ? 'info' : 'mute'">{{ r.label }}</span>
                <span class="mono applied">{{ r.applied }}</span>
              </div>
            </div>

            <div class="baseline-box">
              <div class="hint">重算对照：钉住当前刀路为基线，之后改档位/材料/失败策略，刀路、净面积、待处理数的前后差异直接显示在上方统计里。</div>
              <div class="btn-row">
                <button class="tiny" @click="pinBaseline">{{ baseline ? '重新钉基线' : '钉住基线（改前）' }}</button>
                <button class="tiny" :disabled="!baseline" @click="clearBaseline">取消对照</button>
                <span v-if="baseline" class="hint">基线 {{ baseline.at }}：刀路 {{ baseline.cutLen.toFixed(0) }}mm｜切出净面积 {{ baseline.cutNetArea.toFixed(0) }}mm²｜待处理 {{ baseline.pending }}</span>
              </div>
            </div>

            <div class="btn-row" style="margin-top: 6px">
              <button class="tiny" @click="rule === 'manual' ? store.clearManualBridges(project, selectedContourId ?? undefined) : null">
                清空手工连刀点
              </button>
            </div>
          </div>
        </div>

        <div class="section">
          <div class="section-title">材料</div>
          <select :value="project.materialId" @change="store.setMaterial(project, ($event.target as HTMLSelectElement).value)">
            <option v-for="m in state.materials" :key="m.id" :value="m.id">{{ m.name }}</option>
          </select>
          <div class="hint" style="margin-top: 5px">
            刀压 {{ store.materialOf(project)?.force }}｜速度 {{ store.materialOf(project)?.speedMmS }}mm/s｜重复 {{ store.materialOf(project)?.passes }} 次｜刀偏
            {{ store.materialOf(project)?.bladeOffsetMm }}mm
          </div>
          <div class="btn-row" style="margin-top: 6px">
            <button class="tiny" @click="router.push('/materials')">管理材料预设</button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.tool-group {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.banner.err {
  background: rgba(255, 107, 107, 0.12);
  border: 1px solid rgba(255, 107, 107, 0.4);
  color: #ffb3b3;
  padding: 6px 8px;
  border-radius: 5px;
  margin-bottom: 8px;
  font-size: 12px;
}

.section-title {
  cursor: pointer;
}

.check {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text-dim);
  margin-top: 4px;
}

.bridge-list {
  margin-top: 6px;
  max-height: 90px;
  overflow: auto;
  font-size: 11px;
  color: var(--text-mute);
  line-height: 1.7;
}

.delta {
  display: block;
  font-size: 10px;
  font-weight: normal;
  line-height: 1.2;
}
.delta.up {
  color: var(--err);
}
.delta.down {
  color: #47c07a;
}

.pending-row {
  align-items: flex-start;
  gap: 6px;
}
.pending-actions {
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex: 0 0 auto;
}

.offset-box {
  margin-top: 8px;
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 6px 8px;
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.offset-title {
  font-size: 12px;
  color: var(--text-dim);
  display: flex;
  align-items: center;
}
.seg {
  display: flex;
  gap: 4px;
}
.seg button {
  flex: 1;
  font-size: 11px;
  padding: 4px 2px;
  border: 1px solid var(--line);
  border-radius: 4px;
  background: transparent;
  color: var(--text-dim);
  cursor: pointer;
}
.seg button.active {
  border-color: #47c07a;
  color: #47c07a;
  background: rgba(71, 192, 122, 0.1);
}
.err-text {
  color: #ffb3b3;
}

.offset-list-head {
  margin-top: 6px;
  cursor: pointer;
}
.offset-list {
  margin-top: 4px;
  max-height: 160px;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
  border: 1px solid var(--line);
  border-radius: 5px;
  padding: 4px;
}
.offset-row {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  padding: 2px 3px;
  border-radius: 4px;
  cursor: pointer;
}
.offset-row:hover {
  background: rgba(255, 255, 255, 0.05);
}
.offset-row.err {
  background: rgba(255, 107, 107, 0.1);
}
.offset-row.warn {
  background: rgba(255, 143, 60, 0.08);
}
.offset-row.info .applied {
  color: #6db8ff;
}
.offset-row.mute .applied {
  color: var(--text-mute);
}
.applied {
  flex: 0 0 58px;
  text-align: right;
  font-size: 11px;
  color: var(--text-dim);
}
.tag.mute {
  background: rgba(255, 255, 255, 0.06);
  color: var(--text-mute);
}
.baseline-box {
  margin-top: 6px;
  padding: 6px 8px;
  border: 1px dashed var(--line);
  border-radius: 6px;
  display: flex;
  flex-direction: column;
  gap: 5px;
}
</style>