<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import PreviewCanvas from '@/components/PreviewCanvas.vue'
import { store, state } from '@/logic/store'
import { PATTERN_LIBRARY, fetchPatternText } from '@/data/patterns'
import type { Contour, ContourOffsetRule, ContourWarning, OffsetFailureAction, Pt, Shape } from '@/logic/types'
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
const showCompare = ref(true)
const showBaseline = ref(false)

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
  let naive = 0
  let ms = 0
  let fragments = 0
  let maxDepth = 1
  let dev = 0
  let cutLen = 0
  let baseCutLen = 0
  let travel = 0
  let baseTravel = 0
  let netArea = 0
  let baseNetArea = 0
  let offsetApplied = 0
  let offsetReduced = 0
  let offsetPending = 0
  let offsetDisabled = 0
  for (const s of shapes.value) {
    const c = store.computedOf(s.id)
    if (!c) continue
    contours += c.stats.contourCount
    closed += c.stats.closedCount
    open += c.stats.openCount
    bridges += c.stats.bridgeCount
    fragments += c.stats.fragmentCount
    cutLen += c.stats.cutLengthMm
    baseCutLen += c.stats.baselineCutLengthMm
    travel += c.stats.travelMm
    baseTravel += c.stats.baselineTravelMm
    naive += c.stats.naiveTravelMm
    netArea += c.stats.netAreaMm2
    baseNetArea += c.stats.baselineNetAreaMm2
    offsetApplied += c.stats.offsetApplied
    offsetReduced += c.stats.offsetReduced
    offsetPending += c.stats.offsetPending
    offsetDisabled += c.stats.offsetDisabled
    ms += c.elapsedMs
    maxDepth = Math.max(maxDepth, c.stats.maxDepth)
    dev = Math.max(dev, c.stats.geometryDeviationMm)
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
    baseNetArea,
    baseCutLen,
    baseTravel,
    offsetApplied,
    offsetReduced,
    offsetPending,
    offsetDisabled,
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
        } else if (w === 'offset_pending' || w === 'offset_failed') {
          out.push({ id: `${c.id}-of`, shapeId: s.id, contourId: c.id, kind: w, text: comp?.byId.get(c.id)?.offsetMessage || '刀补偏置失败，已按原路径出图', level: 'err' })
        } else if (w === 'offset_reduced') {
          out.push({ id: `${c.id}-or`, shapeId: s.id, contourId: c.id, kind: w, text: comp?.byId.get(c.id)?.offsetMessage || '刀补已缩小后重试成功', level: 'warn' })
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

const materialOffset = computed(() => store.materialOf(project.value!)?.bladeOffsetMm ?? 0)

const selectedOffsetRule = computed<ContourOffsetRule>(() => ({
  mode: selectedContour.value?.offsetRule?.mode ?? 'material',
  customMm: selectedContour.value?.offsetRule?.customMm ?? materialOffset.value,
  failureAction: selectedContour.value?.offsetRule?.failureAction ?? project.value?.settings.offsetFailureAction ?? 'retry_reduced',
}))

type ContourRow = {
  shapeId: string
  contour: Contour
  status: string
  state: string
  mode: string
  applied: number
  requested: number
}

const offsetStateText: Record<string, string> = {
  off: '不偏',
  open: '开曲线',
  applied: '已偏置',
  clipped: '已裁剪',
  reduced: '缩小重试',
  pending: '待处理',
}

const contourRows = computed<ContourRow[]>(() => {
  const out: ContourRow[] = []
  for (const s of shapes.value) {
    const comp = store.computedOf(s.id)
    for (const c of s.contours) {
      const m = comp?.byId.get(c.id)
      out.push({
        shapeId: s.id,
        contour: c,
        status: !c.closed ? '开曲线' : m ? offsetStateText[m.offsetState] ?? '-' : '-',
        state: !c.closed ? 'open' : m?.offsetState ?? 'off',
        mode: !c.closed ? '开放路径不做刀补' : m?.offset.modeLabel ?? '跟随材料',
        applied: m?.offset.appliedMm ?? 0,
        requested: m?.offset.requestedMm ?? 0,
      })
    }
  }
  return out
})

function setContourOffsetMode(mode: ContourOffsetRule['mode']): void {
  const p = project.value
  const c = selectedContour.value
  if (!p || !c) return
  store.updateContourOffset(p, c.id, {
    mode,
    customMm: selectedOffsetRule.value.customMm || materialOffset.value || 0.2,
    failureAction: selectedOffsetRule.value.failureAction,
  })
}

function setContourCustomMm(value: number): void {
  const p = project.value
  const c = selectedContour.value
  if (!p || !c || !Number.isFinite(value) || value < 0) return
  store.updateContourOffset(p, c.id, { mode: 'custom', customMm: value })
}

function setContourFailure(action: OffsetFailureAction): void {
  const p = project.value
  const c = selectedContour.value
  if (!p || !c) return
  store.updateContourOffset(p, c.id, { failureAction: action })
}

function resetContourOffset(): void {
  const p = project.value
  const c = selectedContour.value
  if (!p || !c) return
  store.resetContourOffset(p, c.id)
}

function retryContourOffset(contourId: string): void {
  const p = project.value
  if (p) store.updateContourOffset(p, contourId, { failureAction: 'retry_reduced' })
}

function keepContourOriginal(contourId: string): void {
  const p = project.value
  if (p) store.updateContourOffset(p, contourId, { failureAction: 'keep_original' })
}

function disableContourOffset(contourId: string): void {
  const p = project.value
  if (p) store.updateContourOffset(p, contourId, { mode: 'off' })
}

function fmtDelta(v: number, digits = 1, unit = ''): string {
  const n = Math.abs(v) < 0.05 ? 0 : v
  return `${n > 0 ? '+' : ''}${n.toFixed(digits)}${unit}`
}

const computedMap = computed(() => {
  const m = new Map<string, ComputedShape>()
  for (const s of shapes.value) {
    const c = store.computedOf(s.id)
    if (c) m.set(s.id, c)
  }
  return m
})

const compareStats = computed(() => {
  const old = lastTotalStats.value
  const cur = totalStats.value
  return {
    cutLen: old?.cutLen ?? cur.baseCutLen,
    travel: old?.travel ?? cur.baseTravel,
    netArea: old?.netArea ?? cur.baseNetArea,
    problems: old ? cur.offsetPending + cur.offsetReduced : cur.offsetPending + cur.offsetReduced,
    label: old ? '上一次设置' : '未刀补原路径',
  }
})

const lastTotalStats = ref<(typeof totalStats)['value'] | null>(null)
const lastComputedMap = ref<Map<string, ComputedShape> | null>(null)

watch(totalStats, (_v, old) => {
  lastTotalStats.value = old ?? null
}, { flush: 'post' })
watch(computedMap, (_v, old) => {
  lastComputedMap.value = old ?? null
}, { flush: 'post' })
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
        :show-baseline="showBaseline"
        :baseline-computed="lastComputedMap"
        :selected-contour-id="selectedContourId"
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
          <span><i style="background: #ff6b6b"></i>自交</span>
          <span><i style="background: #b48cff"></i>重复路径</span>
          <span v-if="mode === 'toolpath'"><i style="background: #ff8f3c"></i>刀路</span>
          <span v-if="mode === 'toolpath' && showBaseline"><i style="background: #7f8fa3"></i>重算前</span>
          <span v-if="mode === 'outline'"><i style="background: #47c07a"></i>已偏置</span>
          <span v-if="mode === 'outline'"><i style="background: #ffc857"></i>缩小重试</span>
          <span v-if="mode === 'outline'"><i style="background: #ff6b6b"></i>待处理</span>
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
          <div class="stat"><div class="k">刀路总长</div><div class="v">{{ totalStats.cutLen.toFixed(0) }}<small>{{ fmtDelta(totalStats.cutLen - compareStats.cutLen, 0, 'mm') }}</small></div></div>
          <div class="stat"><div class="k">净面积</div><div class="v">{{ totalStats.netArea.toFixed(0) }}<small>{{ fmtDelta(totalStats.netArea - compareStats.netArea, 0, 'mm²') }}</small></div></div>
          <div class="stat"><div class="k">刀补档/待处理</div><div class="v">{{ totalStats.offsetApplied }}<small>/{{ totalStats.offsetPending }}</small></div></div>
          <div class="stat"><div class="k">跳刀 / 优化</div><div class="v">{{ totalStats.travel.toFixed(0) }}<small>mm · {{ totalStats.improve >= 0 ? '−' : '+' }}{{ Math.abs(totalStats.improve).toFixed(1) }}%</small></div></div>
          <div class="stat"><div class="k">嵌套层数</div><div class="v">{{ totalStats.maxDepth }}</div></div>
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
              <div v-for="p in problems" :key="p.id" class="list-item problem-item" @click="locate(p)">
                <span class="tag" :class="p.level === 'err' ? 'err' : p.level === 'warn' ? 'warn' : 'info'">{{ p.kind }}</span>
                <span class="grow problem-text">{{ p.text }}</span>
                <template v-if="p.kind === 'offset_pending' || p.kind === 'offset_failed'">
                  <button class="tiny" @click.stop="retryContourOffset(p.contourId)">缩小重试</button>
                  <button class="tiny" @click.stop="keepContourOriginal(p.contourId)">按原路径待处理</button>
                </template>
              </div>
            </div>
          </div>
        </div>

        <div class="section">
          <div class="section-title">
            刀补分档
            <span class="tag" :class="totalStats.offsetPending ? 'err' : 'ok'">{{ totalStats.offsetApplied }} 已偏置｜{{ totalStats.offsetPending }} 待处理</span>
          </div>
          <div class="offset-list">
            <div
              v-for="row in contourRows"
              :key="row.contour.id"
              class="offset-row"
              :class="{ active: row.contour.id === selectedContourId }"
              @click="onSelectContour(row.contour.id, row.shapeId)"
            >
              <span class="grow">
                <span class="tag" :class="`off-${row.state}`">{{ row.status }}</span>
                {{ row.mode }}
                <span class="dim" v-if="row.requested > 0">（{{ row.applied > 0 ? row.applied.toFixed(2) : row.requested.toFixed(2) }}mm）</span>
              </span>
              <button class="tiny" :disabled="!row.contour.closed" @click.stop="disableContourOffset(row.contour.id)">不偏</button>
            </div>
            <div v-if="contourRows.length === 0" class="empty">当前还没有闭合轮廓。</div>
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
              <div v-if="selMetrics" class="hint" style="margin-top: 6px">
                当前刀补：{{ selMetrics.offset.modeLabel }}｜{{ selMetrics.offsetState === 'off' ? '未偏置' : `实际 ${selMetrics.offset.appliedMm.toFixed(3)}mm` }}｜失败策略：{{ selMetrics.offset.actionLabel }}
              </div>
              <div v-if="selMetrics && selMetrics.offsetMessage" class="hint" :class="{ pending: selMetrics.offsetState === 'pending' }">
                {{ selMetrics.offsetMessage }}
              </div>
              <div v-if="selectedContour && !selectedContour.closed" class="hint">开放路径不做刀补；闭合后才能单独设置跟随材料、指定量或不偏。</div>
              <div class="offset-editor" v-if="settings && selectedContour?.closed">
                <div class="field-row">
                  <label>刀补档位</label>
                  <select :value="selectedOffsetRule.mode" :disabled="!selectedContour || !selectedContour.closed" @change="setContourOffsetMode(($event.target as HTMLSelectElement).value as ContourOffsetRule['mode'])">
                    <option value="material">跟随材料（{{ materialOffset.toFixed(2) }}mm）</option>
                    <option value="custom">按指定量偏置</option>
                    <option value="off">不偏置</option>
                  </select>
                </div>
                <div class="field-row" v-if="selectedOffsetRule.mode === 'custom'">
                  <label>指定刀补</label>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    :value="selectedOffsetRule.customMm"
                    :disabled="!selectedContour || !selectedContour.closed"
                    @change="setContourCustomMm(Number(($event.target as HTMLInputElement).value))"
                  />
                  <span class="hint">mm</span>
                </div>
                <div class="field-row">
                  <label>失败后</label>
                  <select :value="selectedOffsetRule.failureAction" :disabled="!selectedContour || !selectedContour.closed" @change="setContourFailure(($event.target as HTMLSelectElement).value as OffsetFailureAction)">
                    <option value="retry_reduced">缩小到 {{ Math.round(settings.offsetRetryRatio * 100) }}% 重试一次</option>
                    <option value="keep_original">按原路径出图并列入待处理</option>
                  </select>
                </div>
                <div class="btn-row">
                  <button class="tiny" :disabled="!selectedContour || !selectedContour.closed" @click="resetContourOffset">恢复跟随材料</button>
                  <button class="tiny" :disabled="!selectedContour || !selectedContour.closed" @click="selectedContour && disableContourOffset(selectedContour.id)">此轮廓不偏</button>
                </div>
                <div v-if="selMetrics" class="diff-grid">
                  <span>刀路 {{ selMetrics.originalLengthMm.toFixed(1) }} → {{ selMetrics.toolpathLengthMm.toFixed(1) }}mm</span>
                  <span>净面积 {{ selMetrics.originalAreaMm2.toFixed(1) }} → {{ selMetrics.toolpathAreaMm2.toFixed(1) }}mm²</span>
                  <span>Δ长度 {{ fmtDelta(selMetrics.lengthDeltaMm, 2) }}mm</span>
                  <span>Δ面积 {{ fmtDelta(selMetrics.areaDeltaMm2, 2) }}mm²</span>
                </div>
              </div>
              <div v-if="selMetrics && selMetrics.anchors.length" class="bridge-list">
                <div v-for="(b, i) in selMetrics.anchors.slice(0, 30)" :key="i" class="mono">
                  #{{ i + 1 }} 锚点 ({{ b.at.x.toFixed(2) }}, {{ b.at.y.toFixed(2) }})｜宽 {{ b.widthMm.toFixed(3) }}mm
                </div>
              </div>
            </template>
          </div>
        </div>

        <div class="section">
          <div class="section-title" @click="showCompare = !showCompare">
            重算前后对照
            <span class="spacer"></span>
            <label class="inline-check"><input type="checkbox" v-model="showBaseline" :disabled="mode !== 'toolpath'" /> 刀路上叠原路径</label>
          </div>
          <div v-show="showCompare" class="compare-panel">
            <table class="grid">
              <tbody>
                <tr><th>刀路总长</th><td>{{ compareStats.cutLen.toFixed(1) }} → {{ totalStats.cutLen.toFixed(1) }}mm</td><td :class="totalStats.cutLen - compareStats.cutLen >= 0 ? 'up' : 'down'">{{ fmtDelta(totalStats.cutLen - compareStats.cutLen, 1) }}mm</td></tr>
                <tr><th>跳刀总长</th><td>{{ compareStats.travel.toFixed(1) }} → {{ totalStats.travel.toFixed(1) }}mm</td><td :class="totalStats.travel - compareStats.travel >= 0 ? 'up' : 'down'">{{ fmtDelta(totalStats.travel - compareStats.travel, 1) }}mm</td></tr>
                <tr><th>净面积</th><td>{{ compareStats.netArea.toFixed(1) }} → {{ totalStats.netArea.toFixed(1) }}mm²</td><td :class="totalStats.netArea - compareStats.netArea >= 0 ? 'up' : 'down'">{{ fmtDelta(totalStats.netArea - compareStats.netArea, 1) }}mm²</td></tr>
                <tr><th>问题清单</th><td colspan="2">对照基准：{{ compareStats.label }}｜当前 {{ problems.length }} 项｜缩小重试 {{ totalStats.offsetReduced }}｜待处理 {{ totalStats.offsetPending }}｜单独关闭 {{ totalStats.offsetDisabled }}</td></tr>
              </tbody>
            </table>
            <div class="hint">修改设置后自动保留上一次结果作对照；首次设置时对照未做刀补的原路径。切换到“刀路 · 顺序”后勾选叠原路径：橙色为当前刀路，灰色虚线为对照刀路。</div>
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
            <label class="check"><input type="checkbox" :checked="settings.useBladeOffset" @change="patch((s) => (s.useBladeOffset = ($event.target as HTMLInputElement).checked))" /> 启用刀补总开关（“跟随材料”的轮廓生效；指定量 / 不偏置不受影响）</label>
            <div class="field-row">
              <label>失败策略</label>
              <select :value="settings.offsetFailureAction" @change="patch((s) => (s.offsetFailureAction = ($event.target as HTMLSelectElement).value as OffsetFailureAction))">
                <option value="retry_reduced">缩小后重试一次</option>
                <option value="keep_original">原路径出图并进待处理清单</option>
              </select>
            </div>
            <div class="field-row" v-if="settings.offsetFailureAction === 'retry_reduced'">
              <label>重试比例</label>
              <input type="number" min="0.1" max="0.9" step="0.05" :value="settings.offsetRetryRatio" @change="patch((s) => (s.offsetRetryRatio = Number(($event.target as HTMLInputElement).value)))" />
              <span class="hint">原刀补的倍数</span>
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

.bridge-list,
.offset-list {
  margin-top: 6px;
  max-height: 150px;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.offset-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 5px;
  border: 1px solid transparent;
  border-radius: 5px;
  font-size: 12px;
}

.offset-row.active {
  border-color: var(--line);
  background: rgba(90, 169, 255, 0.08);
}

.off-applied,
.off-clipped {
  background: rgba(71, 192, 122, 0.18);
  color: #79dfa5;
}

.off-reduced {
  background: rgba(255, 200, 87, 0.18);
  color: #ffd879;
}

.off-pending {
  background: rgba(255, 107, 107, 0.18);
  color: #ff9a9a;
}

.off-off {
  background: rgba(127, 143, 163, 0.18);
  color: #aebac8;
}

.dim {
  color: var(--text-mute);
}

.problem-item {
  align-items: flex-start;
}

.problem-text {
  line-height: 1.45;
}

.pending {
  color: #ffb3b3;
}

.offset-editor {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid var(--line);
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.diff-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 4px 8px;
  margin-top: 6px;
  font-size: 11px;
  color: var(--text-dim);
}

.inline-check {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: var(--text-dim);
  font-weight: 400;
}

.compare-panel .grid td.up {
  color: #ffb37a;
}

.compare-panel .grid td.down {
  color: #79dfa5;
}
</style>