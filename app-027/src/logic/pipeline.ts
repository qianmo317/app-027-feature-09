import type { Bridge, ContourOffsetCfg, ContourWarning, CutSettings, MaterialPreset, OffsetMode, Pt, Shape } from './types'
import { DEFAULT_CONTOUR_OFFSET, MIN_RETRY_OFFSET_MM } from './types'
import { anchorsFromRuns, applyBridges, planBridges, type BridgeAnchor, type BridgeMetrics, type CutRun } from './bridges'
import { buildContainmentTree, type NestingResult } from './nesting'
import { orderCut, type OrderResult } from './order'
import { offsetPolygon } from './offset'
import { boundsOf, mergeBounds, polygonArea, polylineLength, type Bounds } from './geometry'

/** 单条轮廓的刀补解析结果（供属性面板 / 画布角标使用） */
export type OffsetStatus = {
  /** 当前档位 */
  mode: OffsetMode
  /** 偏置方向：+1 外层向外 / -1 内层向内 / 0 未闭合或未偏置 */
  dir: number
  /** 请求偏置量（mm，始终为正）：即设置要求的值 */
  requestedMm: number
  /** 最终实际生效的偏置量（mm，失败回退原路径时为 0） */
  appliedMm: number
  /** 是否做过「缩小一半」重试 */
  retried: boolean
  /** 偏置最终失败：按原路径出图，已进待处理清单 */
  failed: boolean
  /** 凹角自交裁剪过 */
  clipped: boolean
}

export type ComputedContour = {
  id: string
  /** 最终刀路（已做刀补 + 连刀点开挖） */
  runs: CutRun[]
  bridgeMetrics: BridgeMetrics
  /** 连刀点锚点（预览 / 放大视图） */
  anchors: BridgeAnchor[]
  offsetOk: boolean
  offsetMessage: string
  offset: OffsetStatus
  /** 最终刀路（偏置后、未挖缺口）按层符号计入的净面积 mm²；未偏置/失败时为原始面积 */
  netAreaMm2: number
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
    travelMm: number
    naiveTravelMm: number
    improvementPct: number
    approachMm: number
    bridgeCount: number
    fragmentCount: number
    cappedBridgeCount: number
    maxDepth: number
    /** 成品净面积（设计轮廓，未做刀补；偶层为正、奇层为负） */
    netAreaMm2: number
    /** 实际切出净面积（刀补后刀路；失败回退的轮廓按原路径计入） */
    cutNetAreaMm2: number
    /** 待处理清单条数（偏置失败、按原路径出图的轮廓数） */
    offsetPending: number
    bbox: Bounds
    geometryDeviationMm: number
    offsetFailed: number
  }
  /** 需要写回轮廓的警告 */
  warningUpdates: Map<string, ContourWarning[]>
  elapsedMs: number
  signature: string
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
    // 手工连刀点也参与签名
    for (const b of c.bridges) h = (h + b.atIndex * 1.7 + b.widthMm * 11.3) % 1e9
    // 每条轮廓的刀补档位也参与签名
    const oc = c.offsetCfg ?? DEFAULT_CONTOUR_OFFSET
    h = (h + oc.customMm * 17.7 + (oc.mode === 'custom' ? 13 : oc.mode === 'off' ? 29 : 7)) % 1e9
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
    settings.offsetFailPolicy,
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
 * 解析单条轮廓请求的偏置量。
 * - material：总开关开启时取材料刀偏，否则不偏
 * - custom：始终按轮廓自带的偏置量（总开关只控制 material 档）
 * - off：不偏
 */
function resolveOffsetRequest(
  cfg: ContourOffsetCfg | undefined,
  settings: CutSettings,
  material: MaterialPreset | null,
): { mode: OffsetMode; mm: number } {
  const oc = cfg ?? DEFAULT_CONTOUR_OFFSET
  if (oc.mode === 'off') return { mode: 'off', mm: 0 }
  if (oc.mode === 'custom') return { mode: 'custom', mm: Math.max(0, oc.customMm) }
  return { mode: 'material', mm: settings.useBladeOffset && material ? material.bladeOffsetMm : 0 }
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
  let offsetFailed = 0
  let offsetPending = 0
  const cutNetAreas = new Map<string, number>()

  for (const c of shape.contours) {
    const warnings: ContourWarning[] = []
    const depth = tree.depthOf.get(c.id) ?? 1
    const offsetDir = depth % 2 === 1 ? 1 : -1 // 外层向外、内层（孔）向内
    const { mode: offsetMode, mm: requestMmRaw } = resolveOffsetRequest(c.offsetCfg, settings, material)
    const requestMm = c.closed ? requestMmRaw : 0
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

    // 2) 刀补（会产生凹角自交，需裁剪）
    //    失败策略：retry_halved → 缩小一半自动重试一次；passthrough → 原路径出图并进待处理清单
    let loops: Pt[][] = [c.points]
    let offsetOk = true
    let offsetMessage = ''
    let appliedMm = 0
    let retried = false
    let clipped = false
    let failed = false
    if (requestMm > 1e-6) {
      let res = offsetPolygon(c.points, requestMm * offsetDir)
      appliedMm = requestMm
      if (!res.ok && settings.offsetFailPolicy === 'retry_halved' && requestMm * 0.5 >= MIN_RETRY_OFFSET_MM) {
        // 缩小偏置重试一次
        retried = true
        const reduced = requestMm * 0.5
        const res2 = offsetPolygon(c.points, reduced * offsetDir)
        if (res2.ok) {
          res = res2
          appliedMm = reduced
          clipped = res2.clipped
          offsetMessage =
            `刀补 ${requestMm.toFixed(2)}mm 偏置失败，已按一半 ${reduced.toFixed(2)}mm 重试成功（${res2.clipped ? '凹角自交已裁剪' : '无自交'}）；` +
            `如需全量刀补请缩小图形尺度或改用更小刀偏。`
          warnings.push('offset_reduced')
          if (res2.clipped) warnings.push('offset_clipped')
        } else {
          // 重试仍失败 → 原路径出图，进待处理清单
          failed = true
          offsetFailed += 1
          offsetPending += 1
          appliedMm = 0
          offsetMessage =
            `刀补 ${requestMm.toFixed(2)}mm 偏置失败，缩小一半 ${reduced.toFixed(2)}mm 重试仍失败，` +
            `已按原路径出图并加入待处理清单（可在清单中改用更小偏置量或将该轮廓设为不偏）。`
          warnings.push('offset_pending')
        }
      } else if (!res.ok) {
        // passthrough：原路径出图，进待处理清单
        failed = true
        offsetFailed += 1
        offsetPending += 1
        appliedMm = 0
        offsetMessage =
          `刀补 ${requestMm.toFixed(2)}mm 偏置失败（凹角自交无法裁剪或轮廓消失），` +
          `已按原路径出图并加入待处理清单（可缩小偏置重试，或将该轮廓设为不偏）。`
        warnings.push('offset_pending')
      } else {
        clipped = res.clipped
        offsetMessage = res.message
        if (res.clipped) warnings.push('offset_clipped')
      }
      if (!failed && res.ok) loops = res.runs.map((r) => r.points)
      offsetOk = !failed
    }

    // 3) 连刀点开挖 → 切割段
    const runs = c.closed ? mapGapsToLoops(loops, gapFracs) : [{ points: c.points, closed: false }]
    const anchors = c.closed
      ? anchorsFromRuns(
          runs,
          plan.metrics.appliedWidthMm,
          plan.gaps.map((g) => g.atIndex),
          plan.gaps.length,
        )
      : []

    // 刀补后净面积：多个偏置环（凹角裁剪可能拆环）各自按面积代数值计入，层符号在外
    const sign = depth % 2 === 1 ? 1 : -1
    const contourCutArea = c.closed
      ? sign * loops.reduce((sum, lp) => sum + Math.abs(polygonArea(lp)), 0)
      : 0
    cutNetAreas.set(c.id, contourCutArea)

    const offsetStatus: OffsetStatus = {
      mode: offsetMode,
      dir: c.closed ? offsetDir : 0,
      requestedMm: requestMm,
      appliedMm,
      retried,
      failed,
      clipped,
    }

    byId.set(c.id, { id: c.id, runs, bridgeMetrics: plan.metrics, anchors, offsetOk, offsetMessage, offset: offsetStatus, netAreaMm2: contourCutArea })
    runsOf.set(c.id, runs)
    if (warnings.length > 0) warningUpdates.set(c.id, warnings)
  }

  // 4) 切割顺序：先内后外 + 同层最近邻/2-opt
  const order = orderCut(runsOf, tree, {
    optimize: settings.travelOptimize,
    start,
    layerOf: () => shape.layer,
  })

  let cutLengthMm = 0
  for (const st of order.steps) cutLengthMm += st.lengthMm

  // 成品净面积：偶层为正、奇层（孔）为负（设计轮廓，不做刀补）
  let netAreaMm2 = 0
  for (const c of shape.contours) {
    if (!c.closed) continue
    const depth = tree.depthOf.get(c.id) ?? 1
    netAreaMm2 += (depth % 2 === 1 ? 1 : -1) * polygonArea(c.points)
  }
  // 实际切出净面积：偏置后的刀路面积（失败回退的轮廓按原路径计入）
  let cutNetAreaMm2 = 0
  for (const v of cutNetAreas.values()) cutNetAreaMm2 += v

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
      travelMm: order.travelMm,
      naiveTravelMm: order.naiveTravelMm,
      improvementPct: order.improvementPct,
      approachMm: order.approachMm,
      bridgeCount,
      fragmentCount,
      cappedBridgeCount,
      maxDepth: tree.maxDepth,
      netAreaMm2,
      cutNetAreaMm2,
      offsetPending,
      bbox,
      geometryDeviationMm,
      offsetFailed,
    },
    warningUpdates,
    elapsedMs: performance.now() - t0,
    signature: shapeSignature(shape, settings, material),
  }
}

export type { Bridge }