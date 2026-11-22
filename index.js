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
const ALERT_TTL_MS = 60_000
const PLATFORM_USAGE_URL = 'https://platform.deepseek.com/api/v0/usage/by_api_key/cost'
const TZ_SECONDS = 8 * 3600

// 高峰时段（北京时间）：周一至周五 09:00–12:00、14:00–18:00，不含法定节假日。
const PEAK_WINDOWS_MIN = [
  [9 * 60, 12 * 60],
  [14 * 60, 18 * 60],
]

// 法定节假日不内置：按北京日期「每天首次读取」时从公开数据源拉全年 JSON 并缓存（数据很小），
// 拉取失败时按 15 分钟退避重试；接近年末再顺带拉下一年，覆盖跨年切换。
const HOLIDAY_URL = 'https://cdn.jsdelivr.net/gh/NateScarlet/holiday-cn@master'
const HOLIDAY_TIMEOUT_MS = 10_000
const HOLIDAY_RETRY_MS = 15 * 60 * 1000
let holidaySet = new Set()
let holidayDate = ''
let holidayAttempt = 0

async function fetchHolidays(year) {
  try {
    const response = await fetch(`${HOLIDAY_URL}/${year}.json`, { signal: AbortSignal.timeout(HOLIDAY_TIMEOUT_MS) })
    if (!response.ok) return null
    const json = await response.json()
    const days = Array.isArray(json && json.days) ? json.days : []
    const set = new Set()
    for (const day of days) {
      if (day && day.isOffDay === true && typeof day.date === 'string') set.add(day.date)
    }
    return set
  } catch (_err) {
    return null
  }
}

async function ensureHolidays(now) {
  const facts = beijingFacts(now)
  if (holidayDate === facts.date) return
  if (holidayAttempt !== 0 && now - holidayAttempt < HOLIDAY_RETRY_MS) return
  holidayAttempt = now
  const year = Number(facts.date.slice(0, 4))
  const current = await fetchHolidays(String(year))
  if (current === null) return
  let merged = current
  if (Number(facts.date.slice(5, 7)) >= 11) {
    const next = await fetchHolidays(String(year + 1))
    if (next !== null) merged = new Set([...current, ...next])
  }
  holidaySet = merged
  holidayDate = facts.date
}

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
  if (holidaySet.has(facts.date)) return false
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

/** Read the platform-configured balance alert bound (the "余额预警" set on platform.deepseek.com). */
async function fetchAlertBound(account) {
  if (account === undefined || typeof account.getPlatformSession !== 'function') return null
  let session
  try { session = await account.getPlatformSession() } catch (_err) { return null }
  if (session === null || session === undefined) return null
  try {
    const response = await fetch('https://platform.deepseek.com/auth-api/v0/users/current', {
      method: 'GET',
      headers: { 'x-dsh-auth-token': session.token, ...(session.requestHeaders || {}) },
      signal: AbortSignal.timeout(USAGE_TIMEOUT_MS),
    })
    if (!response.ok) return null
    const json = await response.json()
    const biz = json && json.data ? json.data.biz_data : undefined
    const alert = biz && biz.balance_alert ? biz.balance_alert : undefined
    if (alert === undefined || alert === null) return null
    const read = (side) => {
      const entry = alert[side]
      if (entry === undefined || entry === null) return { enabled: false, bound: 0 }
      return { enabled: entry.enabled === true, bound: Number(entry.alert_bound) || 0 }
    }
    return { CNY: read('CNY'), USD: read('USD') }
  } catch (_err) {
    return null
  }
}

/** Test-mode overrides: force a state so the UI can be verified without real data. */
const TEST_MODES = new Set(['low', 'peak', 'peakLow', 'near', 'far', 'nokey', 'error', 'empty'])

function mockStatus(mode, now) {
  const status = {
    period: 'valley',
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
  if (mode === 'low' || mode === 'peakLow') {
    status.balance = {
      status: 'ok',
      isAvailable: true,
      balances: [{ currency: 'CNY', totalBalance: '5.00', grantedBalance: '0.00', toppedUpBalance: '5.00' }],
      error: null,
    }
  }
  if (mode === 'peak' || mode === 'peakLow') {
    status.period = 'peak'
    status.nextTransitionMs = 2 * 3600 * 1000
  }
  if (mode === 'near') {
    status.period = 'peak'
    status.nextTransitionMs = 5 * 60 * 1000
  }
  if (mode === 'far') {
    status.period = 'valley'
    status.nextTransitionMs = (2 * 24 + 15) * 3600 * 1000
  }
  if (mode === 'nokey') status.balance = { status: 'no-key', isAvailable: null, balances: null, error: null }
  if (mode === 'error') status.balance = { status: 'error', isAvailable: null, balances: null, error: 'HTTP 500' }
  if (mode === 'empty') {
    status.todaySpend = 0
    status.byModel = []
  }
  return status
}

export default {
  name: 'dsh-visualcost',
  apply(root, config) {
    const pick = (value, fallback) => {
      const n = Number(value)
      return Number.isFinite(n) && n >= 0 ? n : fallback
    }
    // 余额预警阈值：0 表示关闭预警；可在 cordis.patch.yml 里改。
    const lowBalanceCNY = pick(config && config.lowBalanceCNY, 100)
    const lowBalanceUSD = pick(config && config.lowBalanceUSD, 15)
    root.inject(['webServer', 'credentials'], (ctx) => {
      let balanceCache = { at: 0, value: null }
      let usageCache = { at: 0, value: { status: 'no-account' } }
      let alertCache = { at: 0, value: null }

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
        await ensureHolidays(now)

        let query
        try { query = new URL(req.url || '/', 'http://localhost').searchParams } catch (_err) { query = new URLSearchParams() }
        const test = query.get('test') || ''
        if (TEST_MODES.has(test)) {
          const mock = mockStatus(test, now)
          mock.lowBalance = { cny: lowBalanceCNY, usd: lowBalanceUSD }
          res.writeHead(200, JSON_HEADERS)
          res.end(JSON.stringify(mock))
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

        let alert = alertCache.value
        if (alert === null || now - alertCache.at >= ALERT_TTL_MS) {
          alert = await fetchAlertBound(ctx.get('deepseekAccount'))
          alertCache = { at: now, value: alert }
        }
        // Prefer the platform-configured "余额预警" bound; fall back to the plugin config.
        const lowBalance = alert !== null
          ? { cny: alert.CNY.enabled ? alert.CNY.bound : 0, usd: alert.USD.enabled ? alert.USD.bound : 0 }
          : { cny: lowBalanceCNY, usd: lowBalanceUSD }

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
          lowBalance,
          alertEnabled: alert !== null ? (alert.CNY.enabled || alert.USD.enabled) : null,
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
