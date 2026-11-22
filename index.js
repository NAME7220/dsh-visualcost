/**
 * Host half of the API balance / peak-valley plugin.
 *
 * Consumption amount comes from the platform's own usage endpoint
 * `/api/v0/usage/by_api_key/cost` (the same endpoint the usage page calls),
 * with `start`/`end`/`tz` aligned to Beijing time so today's bucket is included.
 * It authenticates with the signed-in account token from the `deepseekAccount`
 * service. When that is unavailable the plugin falls back to observed API-balance
 * decreases, then to a local token estimate.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const BALANCE_URL = 'https://api.deepseek.com/user/balance'
const BALANCE_TTL_MS = 60_000
const BALANCE_TIMEOUT_MS = 10_000
const USAGE_TTL_MS = 2 * 60_000
const USAGE_TIMEOUT_MS = 10_000
const PLATFORM_USAGE_URL = 'https://platform.deepseek.com/api/v0/usage/cost'
const TZ_SECONDS = 8 * 3600

// 高峰时段（北京时间）：周一至周五 09:00–12:00、14:00–18:00，不含法定节假日。
const PEAK_WINDOWS_MIN = [
  [9 * 60, 12 * 60],
  [14 * 60, 18 * 60],
]

// 2026 年中国法定节假日「放假」日期（国办发明电〔2025〕7 号）。以后年度请在此补录。
const HOLIDAYS = new Set([
  '2026-01-01', '2026-01-02', '2026-01-03',
  '2026-02-15', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19',
  '2026-02-20', '2026-02-21', '2026-02-22', '2026-02-23',
  '2026-04-04', '2026-04-05', '2026-04-06',
  '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05',
  '2026-06-19', '2026-06-20', '2026-06-21',
  '2026-09-25', '2026-09-26', '2026-09-27',
  '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05',
  '2026-10-06', '2026-10-07',
])

// DeepSeek 单价（元 / 百万 token），顺序 [低谷, 高峰]。
const FLASH_PRICE = { hit: [0.02, 0.04], miss: [1, 2], out: [4, 8] }
const PRO_PRICE = { hit: [0.15, 0.3], miss: [4.5, 9.0], out: [13.5, 27.0] }

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
// 本地账本（平台数据不可用时兜底）：{ date, observedSpend, lastBalance, byModel }
const USAGE_FILE = path.join(DSH_HOME, '.api-balance-usage.json')

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
}

/** Read Beijing wall-clock facts by shifting +8h and reading UTC parts. */
function beijingFacts(epochMs) {
  const shifted = new Date(epochMs + 8 * 3600 * 1000)
  return {
    weekday: shifted.getUTCDay(),
    date: shifted.toISOString().slice(0, 10),
    minutes: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
  }
}

function isPeak(epochMs) {
  const facts = beijingFacts(epochMs)
  if (facts.weekday === 0 || facts.weekday === 6) return false
  if (HOLIDAYS.has(facts.date)) return false
  return PEAK_WINDOWS_MIN.some(([start, end]) => facts.minutes >= start && facts.minutes < end)
}

/** Milliseconds until the next peak/off-peak switch; null when none is found within 12 days. */
function nextTransitionMs(epochMs) {
  const current = isPeak(epochMs)
  const n = Math.floor(epochMs / 1000)
  const day0 = Math.floor((n + 8 * 3600) / 86400) * 86400
  for (let d = 0; d <= 12; d++) {
    for (const edge of [0, 9, 12, 14, 18]) {
      const candidateSec = day0 + d * 86400 + edge * 3600 - 8 * 3600
      if (candidateSec <= n + 1) continue
      if (isPeak(candidateSec * 1000) !== current) return candidateSec * 1000 - epochMs
    }
  }
  return null
}

function priceFor(model) {
  return String(model || '').toLowerCase().indexOf('pro') >= 0 ? PRO_PRICE : FLASH_PRICE
}

function priceInfo(model) {
  const price = priceFor(model)
  return {
    model: String(model || ''),
    hit: { valley: price.hit[0], peak: price.hit[1] },
    miss: { valley: price.miss[0], peak: price.miss[1] },
    out: { valley: price.out[0], peak: price.out[1] },
  }
}

function round4(value) {
  return Math.round(value * 10000) / 10000
}

async function fetchBalance(key) {
  try {
    const response = await fetch(BALANCE_URL, {
      method: 'GET',
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(BALANCE_TIMEOUT_MS),
    })
    if (!response.ok) {
      return { status: 'error', isAvailable: null, balances: null, error: `HTTP ${response.status}` }
    }
    const data = await response.json()
    const balances = Array.isArray(data && data.balance_infos)
      ? data.balance_infos.map(item => ({
        currency: item.currency,
        totalBalance: item.total_balance,
        grantedBalance: item.granted_balance,
        toppedUpBalance: item.topped_up_balance,
      }))
      : []
    return { status: 'ok', isAvailable: data && data.is_available === true, balances, error: null }
  } catch (error) {
    return { status: 'error', isAvailable: null, balances: null, error: error instanceof Error ? error.message : String(error) }
  }
}

/** Read the platform usage cost for one [start, end] window in a timezone. */
async function fetchPlatformUsage(account, startSec, endSec, tzSec) {
  if (account === undefined || typeof account.getPlatformSession !== 'function') return { status: 'no-account' }
  let session
  try { session = await account.getPlatformSession() } catch (error) { return { status: 'error', error: error instanceof Error ? error.message : String(error) } }
  if (session === null || session === undefined) return { status: 'signed-out' }
  const headers = { 'x-dsh-auth-token': session.token, ...(session.requestHeaders || {}) }
  const platform = 'https://platform.deepseek.com'
  // 1. API key tracking ids (the by_api_key endpoints select keys explicitly)
  const keyIds = []
  try {
    const keyResponse = await fetch(`${platform}/api/v0/users/get_api_keys`, { method: 'GET', headers, signal: AbortSignal.timeout(USAGE_TIMEOUT_MS) })
    if (keyResponse.ok) {
      const keyJson = await keyResponse.json()
      const biz = keyJson && keyJson.data ? keyJson.data.biz_data : undefined
      const list = Array.isArray(biz) ? biz : (biz && Array.isArray(biz.keys) ? biz.keys : (biz && Array.isArray(biz.api_keys) ? biz.api_keys : []))
      for (const entry of list) {
        const id = entry && (entry.tracking_id || entry.trackingId)
        if (id) keyIds.push(String(id))
      }
    }
  } catch (_err) { /* key listing optional */ }
  // 2. cost
  const params = new URLSearchParams({ start: String(startSec), end: String(endSec), tz: String(tzSec) })
  for (const id of keyIds) params.append('api_key_tracking_id', id)
  try {
    const response = await fetch(`${platform}/api/v0/usage/by_api_key/cost?${params.toString()}`, { method: 'GET', headers, signal: AbortSignal.timeout(USAGE_TIMEOUT_MS) })
    if (!response.ok) return { status: 'http', http: response.status, keyIds }
    return { status: 'ok', payload: await response.json(), keyIds }
  } catch (error) {
    return { status: 'error', error: error instanceof Error ? error.message : String(error), keyIds }
  }
}

/** Sum the platform cost payload's per-model buckets into money (CNY). */
function platformCost(payload) {
  if (payload === null || payload === undefined || payload.code !== 0) return null
  const biz = payload.data === null || payload.data === undefined ? undefined : payload.data.biz_data
  if (biz === undefined || biz === null) return null
  const currencies = Array.isArray(biz.data) ? biz.data : []
  const chosen = currencies.find(item => item && item.currency === 'CNY') || currencies[0]
  if (chosen === undefined || chosen === null) return null
  let total = 0
  const merged = new Map()
  const collect = (list, fallbackModel) => {
    for (const item of Array.isArray(list) ? list : []) {
      let cost = 0
      for (const bucket of (item && Array.isArray(item.buckets)) ? item.buckets : []) cost += Number(bucket && bucket.cost) || 0
      if (cost > 0) {
        const model = String((item && item.model) || fallbackModel)
        const previous = merged.get(model)
        if (previous === undefined) merged.set(model, cost)
        else merged.set(model, previous + cost)
        total += cost
      }
    }
  }
  collect(chosen.series, 'unknown')
  collect(chosen.function_series, 'function')
  if (merged.size === 0) return null
  const byModel = [...merged.entries()]
    .map(([model, cost]) => ({ model, cost: round4(cost) }))
    .sort((a, b) => b.cost - a.cost)
  return { total: round4(total), byModel }
}

/** Test-mode overrides: force a state so the UI can be verified without real data. */
const TEST_MODES = new Set(['low', 'peak', 'nokey', 'error', 'empty'])

function mockStatus(mode, now) {
  const status = {
    period: isPeak(now) ? 'peak' : 'valley',
    nextTransitionMs: nextTransitionMs(now),
    balance: {
      status: 'ok',
      isAvailable: true,
      balances: [{ currency: 'CNY', totalBalance: '62.59', grantedBalance: '0.00', toppedUpBalance: '62.59' }],
      error: null,
    },
    todaySpend: 19.5026,
    byModel: [
      { model: 'deepseek-v4-pro', cost: 12.9168 },
      { model: 'deepseek-flash', cost: 6.5708 },
      { model: 'tool-search', cost: 0.015 },
    ],
    source: 'test',
    model: '',
    price: priceInfo(''),
    refreshedAt: now,
  }
  if (mode === 'low') {
    status.balance = {
      status: 'ok',
      isAvailable: true,
      balances: [{ currency: 'CNY', totalBalance: '5.00', grantedBalance: '0.00', toppedUpBalance: '5.00' }],
      error: null,
    }
  } else if (mode === 'peak') {
    status.period = 'peak'
    status.nextTransitionMs = 2 * 3600 * 1000
  } else if (mode === 'nokey') {
    status.balance = { status: 'no-key', isAvailable: null, balances: null, error: null }
  } else if (mode === 'error') {
    status.balance = { status: 'error', isAvailable: null, balances: null, error: 'HTTP 500' }
  } else if (mode === 'empty') {
    status.todaySpend = 0
    status.byModel = []
  }
  return status
}

export default {
  name: 'dsh-visualcost',
  apply(root) {
    root.inject(['webServer', 'credentials'], (ctx) => {
      let balanceCache = { at: 0, value: null }
      let usageCache = { at: 0, value: { status: 'no-account' } }

      const sessionModel = new Map() // sessionId -> model
      let observedSpend = 0
      let lastBalance = null
      let todayByModel = new Map()
      let todayKey = ''

      function maybeResetToday(epochMs) {
        const key = beijingFacts(epochMs).date
        if (todayKey === '') {
          todayKey = key
          try {
            const parsed = JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8'))
            if (parsed && parsed.date === key) {
              if (typeof parsed.observedSpend === 'number' && parsed.observedSpend >= 0) observedSpend = parsed.observedSpend
              if (typeof parsed.lastBalance === 'number') lastBalance = parsed.lastBalance
              if (parsed.byModel && typeof parsed.byModel === 'object') {
                for (const [model, cost] of Object.entries(parsed.byModel)) {
                  if (typeof cost === 'number' && cost > 0) todayByModel.set(model, cost)
                }
              }
            }
          } catch (_err) { /* 无账本或读取失败则从 0 开始 */ }
          return
        }
        if (key !== todayKey) {
          todayKey = key
          observedSpend = 0
          lastBalance = null
          todayByModel = new Map()
        }
      }

      function persistToday() {
        try {
          const byModel = {}
          for (const [model, cost] of todayByModel) byModel[model] = round4(cost)
          fs.writeFileSync(USAGE_FILE, JSON.stringify({
            date: todayKey,
            observedSpend: round4(observedSpend),
            lastBalance: lastBalance === null ? null : round4(lastBalance),
            byModel,
          }), 'utf8')
        } catch (_err) { /* 持久化失败不影响展示 */ }
      }

      function observe(balance) {
        if (balance === null || balance === undefined || balance.status !== 'ok') return
        const cny = (balance.balances || []).find(item => item.currency === 'CNY')
        const value = cny ? Number(cny.totalBalance) : NaN
        if (!Number.isFinite(value)) return
        if (lastBalance !== null && value < lastBalance - 0.0001) observedSpend += lastBalance - value
        lastBalance = value
      }

      ctx.effect(() => ctx.on('session/event', (session, event) => {
        try {
          const now = Date.now()
          maybeResetToday(now)
          if (event === null || event === undefined || event.type !== 'assistant/message') return
          const data = event.data
          const usage = data && data.usage
          if (usage === null || usage === undefined || typeof usage !== 'object') return
          const input = Number(usage.inputTokens) || 0
          const cacheTokens = Number(usage.cacheReadTokens) || 0
          const output = Number(usage.outputTokens) || 0
          if (input + cacheTokens + output <= 0) return
          const model = data.message && data.message.source ? String(data.message.source.model || '') : ''
          const price = priceFor(model)
          const off = isPeak(now) ? 1 : 0
          const cost = (cacheTokens / 1e6) * price.hit[off] + (input / 1e6) * price.miss[off] + (output / 1e6) * price.out[off]
          const sid = session && session.id ? String(session.id) : ''
          if (sid) sessionModel.set(sid, model)
          const bucket = model || 'unknown'
          todayByModel.set(bucket, (todayByModel.get(bucket) || 0) + cost)
        } catch (_err) { /* 记账失败不影响主流程 */ }
      }), 'api-balance: usage tracking')

      const handler = async (req, res) => {
        const now = Date.now()
        const facts = beijingFacts(now)
        maybeResetToday(now)

        let query
        try { query = new URL(req.url || '/', 'http://localhost').searchParams } catch (_err) { query = new URLSearchParams() }
        const test = query.get('test') || ''
        if (TEST_MODES.has(test)) {
          res.writeHead(200, JSON_HEADERS)
          res.end(JSON.stringify(mockStatus(test, now)))
          return
        }

        let balance = balanceCache.value
        if (balance === null || now - balanceCache.at >= BALANCE_TTL_MS) {
          try {
            const credential = await ctx.credentials.resolve('DEEPSEEK_API_KEY')
            balance = credential === undefined
              ? { status: 'no-key', isAvailable: null, balances: null, error: null }
              : await fetchBalance(credential.value)
          } catch (error) {
            balance = { status: 'error', isAvailable: null, balances: null, error: error instanceof Error ? error.message : String(error) }
          }
          balanceCache = { at: now, value: balance }
          observe(balance)
        }

        const todayStartSec = Math.floor(Date.parse(`${facts.date}T00:00:00+08:00`) / 1000)
        const todayEndSec = todayStartSec + 86400
        let usageResult = usageCache.value
        if (now - usageCache.at >= USAGE_TTL_MS) {
          usageResult = await fetchPlatformUsage(ctx.get('deepseekAccount'), todayStartSec, todayEndSec, TZ_SECONDS)
          usageCache = { at: now, value: usageResult }
        }
        const platform = usageResult.status === 'ok' ? platformCost(usageResult.payload) : null

        const sessionId = query.get('session') || ''
        const model = sessionId ? (sessionModel.get(sessionId) || '') : ''

        let todaySpend
        let byModel
        let source
        if (platform !== null) {
          todaySpend = platform.total
          byModel = platform.byModel
          source = 'platform'
        } else {
          const estimateSum = [...todayByModel.values()].reduce((sum, cost) => sum + cost, 0)
          const total = observedSpend > 0 ? observedSpend : estimateSum
          todaySpend = round4(total)
          byModel = [...todayByModel.entries()]
            .map(([name, cost]) => {
              const share = estimateSum > 0 ? cost / estimateSum : 0
              return { model: name, cost: round4(total > 0 && estimateSum > 0 ? total * share : cost) }
            })
            .sort((a, b) => b.cost - a.cost)
          source = 'local'
        }

        const payload = {
          period: isPeak(now) ? 'peak' : 'valley',
          nextTransitionMs: nextTransitionMs(now),
          balance,
          todaySpend,
          byModel,
          source,
          model,
          price: priceInfo(model),
          refreshedAt: now,

        }
        persistToday()
        res.writeHead(200, JSON_HEADERS)
        res.end(JSON.stringify(payload))
      }

      ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/api-balance/status.json', handler }), 'api-balance: status route')
    })
  },
}
