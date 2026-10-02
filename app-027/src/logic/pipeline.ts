import type { Bridge, ContourWarning, CutSettings, MaterialPreset, Pt, Shape } from './types'
import { normalizeContourOffsetRule, type OffsetFailureAction } from './types'
import { anchorsFromRuns, applyBridges, planBridges, type BridgeAnchor, type BridgeMetrics, type CutRun } from './bridges'
import { buildContainmentTree, type NestingResult } from './nesting'
import { orderCut, type OrderResult } from './order'
import { offsetPolygon } from './offset'
import { boundsOf, mergeBounds, polygonArea, polylineLength, type Bounds } from './geometry'

export type OffsetState = 'off' | 'applied' | 'clipped' | 'reduced' | 'pending'

export type OffsetExecution = {
  modeLabel: string
  actionLabel: string
  requestedMm: number
  appliedMm: number
  reduced: boolean
  attempts: Array<{ distanceMm: number; ok: boolean; clipped: boolean; message: string }>
}

export type ComputedContour = {
  id: string
  /** 最终刀路（已做刀补 + 连刀点开挖） */
  runs: CutRun[]
  /** 不做刀补时的刀路（仅用于对照） */
  baselineRuns: CutRun[]
  bridgeMetrics: BridgeMetrics
  /** 连刀点锚点（预览 / 放大视图） */
  anchors: BridgeAnchor[]
  offsetOk: boolean
  offsetMessage: string
  offsetState: OffsetState
  offset: OffsetExecution
  originalAreaMm2: number
  toolpathAreaMm2: number
  areaDeltaMm2: number
  originalLengthMm: number
  toolpathLengthMm: number
  lengthDeltaMm: number
}

export type ComputedShape = {
  shapeId: string
  tree: NestingResult
  order: OrderResult
  byId: Map<string, ComputedContour>
  stats: {
    contourCount: number
    closedCount: number
    openCount: number
    cutLengthMm: number
    baselineCutLengthMm: number
    travelMm: number
    baselineTravelMm: number
    naiveTravelMm: number
    improvementPct: number
    approachMm: number
    bridgeCount: number
    fragmentCount: number
    cappedBridgeCount: number
    maxDepth: number
    netAreaMm2: number
    baselineNetAreaMm2: number
    netAreaDeltaMm2: number
    bbox: Bounds
    geometryDeviationMm: number
    offsetApplied: number
    offsetReduced: number
    offsetPending: number
    offsetFailed: number
    offsetDisabled: number
  }
  /** 需要写回轮廓的警告 */
  warningUpdates: Map<string, ContourWarning[]>
  elapsedMs: number
  signature: string
}

function hashString(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0
  return Math.abs(h)
}

/** 几何签名：用于缓存失效判断（点坐标和 / 点数 / 参数） */
export function shapeSignature(shape: Shape, settings: CutSettings, material: MaterialPreset | null): string {
  let h = 0
  let n = 0
  for (const c of shape.contours) {
    for (const p of c.points) {
      h = (h + p.x * 7.13 + p.y * 3.71) % 1e9
      n += 1
    }
    // 手工连刀点与单轮廓刀补配置也参与签名
    for (const b of c.bridges) h = (h + b.atIndex * 1.7 + b.widthMm * 11.3) % 1e9
    h = (h + hashString(JSON.stringify(c.offsetRule ?? {})) * 13.7) % 1e9
  }
  return [
    shape.id,
    shape.layer,
    shape.contours.length,
    n,
    Math.round(h * 1000),
    settings.bridgeRule,
    settings.areaThresholdMm2,
    settings.bridgeWidthMm,
    settings.bridgeEveryMm,
    settings.travelOptimize,
    settings.useBladeOffset,
    settings.offsetFailureAction,
    settings.offsetRetryRatio,
    material ? material.bladeOffsetMm : 0,
  ].join('|')
}

/** 把「按弧长比例」的缺口映射到（可能被刀补裁剪成多段的）刀路上 */
function mapGapsToLoops(
  loops: Pt[][],
  gaps: Array<{ frac: number; widthMm: number; atIndex: number }>,
): CutRun[] {
  if (gaps.length === 0) return loops.map((p) => ({ points: p, closed: true }))
  const lens = loops.map((l) => polylineLength(l, true))
  const total = lens.reduce((a, b) => a + b, 0)
  if (total <= 0) return loops.map((p) => ({ points: p, closed: true }))
  const accStart: number[] = []
  let running = 0
  for (const l of lens) {
    accStart.push(running)
    running += l
  }
  const byLoop: Array<Array<{ s: number; widthMm: number; atIndex: number }>> = loops.map(() => [])
  for (const g of gaps) {
    const s = ((g.frac % 1) + 1) % 1 * total
    let li = loops.length - 1
    for (let i = 0; i < loops.length; i++) {
      if (s >= accStart[i] && (i === loops.length - 1 || s < accStart[i] + lens[i])) {
        li = i
        break
      }
    }
    const sLocal = Math.min(Math.max(0, s - accStart[li]), Math.max(0, lens[li] - 1e-6))
    byLoop[li].push({ s: sLocal, widthMm: g.widthMm, atIndex: g.atIndex })
  }
  const runs: CutRun[] = []
  loops.forEach((pts, i) => {
    const gaps = byLoop[i].map((g) => ({ s: g.s, widthMm: g.widthMm, atIndex: g.atIndex }))
    runs.push(...applyBridges(pts, true, gaps))
  })
  return runs
}

/**
 * 单形状全流程：刀补 → 连刀点 → 包含树 → 切割顺序（先内后外 + 跳刀优化）。
 * 纯函数，不修改传入的 shape。
 */
export function computeShape(
  shape: Shape,
  settings: CutSettings,
  material: MaterialPreset | null,
  start: Pt = { x: 0, y: 0 },
): ComputedShape {
  const t0 = performance.now()
  const tree = buildContainmentTree(shape.contours)

  const byId = new Map<string, ComputedContour>()
  const runsOf = new Map<string, CutRun[]>()
  const warningUpdates = new Map<string, ContourWarning[]>()

  let bridgeCount = 0
  let fragmentCount = 0
  let cappedBridgeCount = 0
  let geometryDeviationMm = 0
  let offsetApplied = 0
  let offsetReduced = 0
  let offsetPending = 0
  let offsetDisabled = 0
  let netAreaMm2 = 0
  let baselineNetAreaMm2 = 0

  const baselineRunsOf = new Map<string, CutRun[]>()

  for (const c of shape.contours) {
    const warnings: ContourWarning[] = []
    const depth = tree.depthOf.get(c.id) ?? 1
    const offsetRule = normalizeContourOffsetRule(c.offsetRule)
    const materialOffsetMm = material?.bladeOffsetMm ?? 0
    const requestedOffsetMm =
      offsetRule.mode === 'off'
        ? 0
        : offsetRule.mode === 'custom'
          ? Math.max(0, offsetRule.customMm)
          : settings.useBladeOffset
            ? materialOffsetMm
            : 0
    const offsetDir = depth % 2 === 1 ? 1 : -1 // 外层向外、内层（孔）向内
    const isFragment = c.closed && c.area < settings.areaThresholdMm2
    if (isFragment) fragmentCount += 1

    // 1) 连刀点规划（原始轮廓上按等弧长取锚点）
    const plan = planBridges(
      c.points,
      c.closed,
      c.area,
      c.length,
      {
        rule: settings.bridgeRule,
        areaThresholdMm2: settings.areaThresholdMm2,
        bridgeWidthMm: settings.bridgeWidthMm,
        bridgeEveryMm: settings.bridgeEveryMm,
      },
      c.bridges.map((b) => b.atIndex),
    )
    bridgeCount += plan.metrics.count
    if (plan.metrics.degraded) {
      cappedBridgeCount += 1
      warnings.push('bridge_degraded')
    }
    geometryDeviationMm = Math.max(geometryDeviationMm, plan.metrics.geometryDeviationMm)
    const L = plan.metrics.lengthBefore || polylineLength(c.points, c.closed)
    const gapFracs = plan.gaps.map((g) => ({
      frac: L > 0 ? g.s / L : 0,
      widthMm: g.widthMm,
      atIndex: g.atIndex,
    }))

    // 2) 刀补：每条轮廓可跟随材料、指定刀补或关闭；失败时按该轮廓策略缩小重试或回退原路径
    let loops: Pt[][] = [c.points]
    let offsetOk = true
    let offsetMessage = '该轮廓未启用刀补'
    let offsetState: OffsetState = 'off'
    let appliedOffsetMm = 0
    let reduced = false
    const attempts: OffsetExecution['attempts'] = []
    const failureAction: OffsetFailureAction = offsetRule.failureAction ?? settings.offsetFailureAction

    if (requestedOffsetMm > 1e-6 && c.closed) {
      const first = offsetPolygon(c.points, requestedOffsetMm * offsetDir)
      attempts.push({ distanceMm: requestedOffsetMm, ok: first.ok, clipped: first.clipped, message: first.message })
      if (first.ok) {
        loops = first.runs.map((r) => r.points)
        appliedOffsetMm = requestedOffsetMm
        offsetOk = true
        offsetState = first.clipped ? 'clipped' : 'applied'
        offsetMessage = first.message
        if (first.clipped) warnings.push('offset_clipped')
      } else if (failureAction === 'retry_reduced' && settings.offsetRetryRatio > 0 && settings.offsetRetryRatio < 1) {
        const retryMm = requestedOffsetMm * settings.offsetRetryRatio
        const retry = offsetPolygon(c.points, retryMm * offsetDir)
        attempts.push({ distanceMm: retryMm, ok: retry.ok, clipped: retry.clipped, message: retry.message })
        if (retry.ok) {
          loops = retry.runs.map((r) => r.points)
          appliedOffsetMm = retryMm
          reduced = true
          offsetOk = true
          offsetState = 'reduced'
          offsetMessage = `原刀补 ${requestedOffsetMm.toFixed(2)}mm 失败，已缩小到 ${retryMm.toFixed(2)}mm 重试成功。${retry.message}`
          warnings.push('offset_reduced')
          if (retry.clipped) warnings.push('offset_clipped')
        } else {
          offsetOk = false
          offsetState = 'pending'
          offsetMessage = `原刀补 ${requestedOffsetMm.toFixed(2)}mm 与缩小后 ${retryMm.toFixed(2)}mm 均失败，已按原路径出图并加入待处理清单：${retry.message}`
          warnings.push('offset_pending')
        }
      } else {
        offsetOk = false
        offsetState = 'pending'
        offsetMessage = `刀补 ${requestedOffsetMm.toFixed(2)}mm 失败，已按原路径出图并加入待处理清单：${first.message}`
        warnings.push('offset_pending')
      }
    } else if (c.closed) {
      offsetMessage =
        offsetRule.mode === 'off'
          ? '该轮廓已单独关闭刀补'
          : settings.useBladeOffset
            ? '材料刀补为 0，按原路径出图'
            : '项目刀补总开关关闭，按原路径出图'
    }

    // 3) 连刀点开挖 → 切割段；同时保留未刀补刀路供重算前后对照
    const baselineRuns = c.closed ? mapGapsToLoops([c.points], gapFracs) : [{ points: c.points, closed: false }]
    const runs = c.closed ? mapGapsToLoops(loops, gapFracs) : [{ points: c.points, closed: false }]
    const anchors = c.closed
      ? anchorsFromRuns(
          runs,
          plan.metrics.appliedWidthMm,
          plan.gaps.map((g) => g.atIndex),
          plan.gaps.length,
        )
      : []

    const originalAreaMm2 = c.closed ? polygonArea(c.points) : 0
    const toolpathAreaMm2 = c.closed ? loops.reduce((sum, pts) => sum + polygonArea(pts), 0) : 0
    const originalLengthMm = c.closed ? polylineLength(c.points, true) : polylineLength(c.points, false)
    const toolpathLengthMm = runs.reduce((sum, r) => sum + polylineLength(r.points, r.closed), 0)
    const modeLabel =
      offsetRule.mode === 'off' ? '不偏置' : offsetRule.mode === 'custom' ? `指定 ${offsetRule.customMm.toFixed(2)}mm` : '跟随材料'
    const actionLabel = failureAction === 'retry_reduced' ? `缩小至 ${Math.round(settings.offsetRetryRatio * 100)}% 重试` : '原路径待处理'

    if (c.closed) {
      const sign = depth % 2 === 1 ? 1 : -1
      netAreaMm2 += sign * toolpathAreaMm2
      baselineNetAreaMm2 += sign * originalAreaMm2
      if (offsetState === 'applied' || offsetState === 'clipped') offsetApplied += 1
      if (offsetState === 'reduced') {
        offsetApplied += 1
        offsetReduced += 1
      }
      if (offsetState === 'pending') offsetPending += 1
      if (offsetState === 'off' && offsetRule.mode === 'off') offsetDisabled += 1
    }

    byId.set(c.id, {
      id: c.id,
      runs,
      baselineRuns,
      bridgeMetrics: plan.metrics,
      anchors,
      offsetOk,
      offsetMessage,
      offsetState,
      offset: {
        modeLabel,
        actionLabel,
        requestedMm: requestedOffsetMm,
        appliedMm: appliedOffsetMm,
        reduced,
        attempts,
      },
      originalAreaMm2,
      toolpathAreaMm2,
      areaDeltaMm2: toolpathAreaMm2 - originalAreaMm2,
      originalLengthMm,
      toolpathLengthMm,
      lengthDeltaMm: toolpathLengthMm - originalLengthMm,
    })
    runsOf.set(c.id, runs)
    baselineRunsOf.set(c.id, baselineRuns)
    if (warnings.length > 0) warningUpdates.set(c.id, warnings)
  }

  // 4) 切割顺序：先内后外 + 同层最近邻/2-opt
  const order = orderCut(runsOf, tree, {
    optimize: settings.travelOptimize,
    start,
    layerOf: () => shape.layer,
  })
  const baselineOrder = orderCut(baselineRunsOf, tree, {
    optimize: settings.travelOptimize,
    start,
    layerOf: () => shape.layer,
  })

  let cutLengthMm = 0
  for (const st of order.steps) cutLengthMm += st.lengthMm
  let baselineCutLengthMm = 0
  for (const st of baselineOrder.steps) baselineCutLengthMm += st.lengthMm

  const bbox =
    shape.contours.length > 0
      ? mergeBounds(shape.contours.map((c) => boundsOf(c.points)))
      : { minX: 0, minY: 0, maxX: 0, maxY: 0 }

  return {
    shapeId: shape.id,
    tree,
    order,
    byId,
    stats: {
      contourCount: shape.contours.length,
      closedCount: shape.contours.filter((c) => c.closed).length,
      openCount: shape.contours.filter((c) => !c.closed).length,
      cutLengthMm,
      baselineCutLengthMm,
      travelMm: order.travelMm,
      baselineTravelMm: baselineOrder.travelMm,
      naiveTravelMm: order.naiveTravelMm,
      improvementPct: order.improvementPct,
      approachMm: order.approachMm,
      bridgeCount,
      fragmentCount,
      cappedBridgeCount,
      maxDepth: tree.maxDepth,
      netAreaMm2,
      baselineNetAreaMm2,
      netAreaDeltaMm2: netAreaMm2 - baselineNetAreaMm2,
      bbox,
      geometryDeviationMm,
      offsetApplied,
      offsetReduced,
      offsetPending,
      offsetFailed: offsetPending,
      offsetDisabled,
    },
    warningUpdates,
    elapsedMs: performance.now() - t0,
    signature: shapeSignature(shape, settings, material),
  }
}

export type { Bridge }