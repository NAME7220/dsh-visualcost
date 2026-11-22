/** Browser half: one status-bar button (balance + period); hover = switch countdown, click = combined dialog. */
window.__ModuleLoader__.load({
  id: 'dsh-visualcost',
  factory(require) {
    const React = require('react')
    const { useState, useEffect, useRef } = React
    const { createPortal } = require('react-dom')
    const h = React.createElement

    const NS = 'api-balance'
    const CACHE_KEY = 'dsh-visualcost'
    const POLL_MS = 60000
    const LOW_CNY = 10
    const LOW_USD = 2

    const zh = {
      peak: '高峰',
      valley: '低谷',
      noKey: '未配置密钥',
      balanceError: '余额获取失败',
      balanceEmpty: '无余额',
      spendTitle: '消费金额 (CNY)',
      topUpBalance: '充值余额',
      noUsage: '今日暂无用量记录',
      unknownModel: '其他',
      switchIn: '距切换',
      remaining: '（剩余）',
      days: '天',
      hours: '小时',
      minutes: '分钟',
      alertOff: '余额预警未开启',
      settings: '设置',
    }
    const en = {
      peak: 'Peak',
      valley: 'Off-peak',
      noKey: 'No API key',
      balanceError: 'Balance unavailable',
      balanceEmpty: 'No balance',
      spendTitle: 'Spend (CNY)',
      topUpBalance: 'Topped-up',
      noUsage: 'No usage recorded today',
      unknownModel: 'Other',
      switchIn: 'Switches in',
      remaining: ' (remaining)',
      days: 'd',
      hours: 'h',
      minutes: 'm',
      alertOff: 'Balance alert off',
      settings: 'Settings',
    }

    const CSS = `
.api-balance-pill{display:inline-flex;align-items:center;min-width:0;font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px))}
.api-balance-btn{display:inline-flex;align-items:center;gap:6px;box-sizing:border-box;max-width:100%;padding:1px 8px;border:none;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-variant-numeric:tabular-nums;line-height:inherit;white-space:nowrap;cursor:pointer}
.api-balance-btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.api-balance-btn[aria-expanded="true"]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.api-balance-sep{color:var(--dsw-alias-separator-primary);margin:0 6px}
.api-balance-label{min-width:0;overflow:hidden;text-overflow:ellipsis}
.api-balance-dot{width:7px;height:7px;border-radius:50%;flex:none}
.api-balance-square{width:9px;height:9px;border-radius:2px;flex:none}
.api-balance-legend{display:inline-flex;align-items:center;gap:6px;min-width:0}
.api-balance-panel{position:fixed;z-index:1100;box-sizing:border-box;min-width:min(280px,calc(100vw - 24px));max-width:min(420px,calc(100vw - 24px));padding:12px 16px;border:0;border-radius:var(--dsw-radius-lg);background:var(--dsw-specific-menu);backdrop-filter:var(--dsw-menu-backdrop-filter);box-shadow:var(--dsw-elevation-prominent);font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);cursor:default;max-height:calc(100dvh - 24px);overflow-y:auto}
.api-balance-title{display:flex;justify-content:space-between;gap:16px;margin-bottom:4px;color:var(--dsw-alias-label-primary);font-weight:500}
.api-balance-title b{font-variant-numeric:tabular-nums}
.api-balance-rule{margin:2px 0 8px;border-top:0.5px solid var(--dsw-alias-border-l2)}
.api-balance-bar{display:flex;width:100%;height:4px;border-radius:2px;overflow:hidden;background:rgba(128,128,128,0.18);margin:6px 0 8px}
.api-balance-bar-seg{height:100%;flex:none}
.api-balance-row{display:flex;justify-content:space-between;gap:16px;padding:1px 0;color:var(--dsw-alias-label-tertiary)}
.api-balance-row em{font-style:normal;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;text-align:right}
.api-balance-strong{color:var(--dsw-alias-label-primary);font-weight:500}
.api-balance-strong em{color:var(--dsw-alias-label-primary);font-weight:700}
.api-balance-row em.api-balance-value{font-weight:500;color:var(--dsw-alias-label-primary)}
.api-balance-tip{position:fixed;z-index:1200;max-width:min(50vw,calc(100vw - 24px));box-sizing:border-box;padding:3px 7px;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-tooltip-bg,#333);color:var(--dsw-alias-tooltip-label,#fff);font-size:13px;line-height:20px;white-space:pre-line;overflow-wrap:break-word;pointer-events:none;font-variant-numeric:tabular-nums}
.api-balance-alert{display:flex;align-items:center;gap:6px;padding:2px 0;color:#ef4444}
.api-balance-alert-text{color:#ef4444}
.api-balance-settings{margin-left:auto;color:var(--dsw-alias-label-secondary);text-decoration:none;border-bottom:1px solid var(--dsw-alias-border-l2);cursor:pointer}
.api-balance-settings:hover{color:var(--dsw-alias-label-primary)}
`

    function CoinIcon() {
      return h('svg', { viewBox: '0 0 16 16', width: 14, height: 14, style: { flex: 'none' }, 'aria-hidden': true },
        h('circle', { cx: 8, cy: 8, r: 6.5, fill: 'none', stroke: 'currentColor', strokeWidth: 1.4 }),
        h('path', {
          d: 'M5.5 5 L8 8 L10.5 5 M8 8 V11 M6 9.6 H10 M6 7.6 H10',
          fill: 'none', stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round', strokeLinejoin: 'round',
        }),
      )
    }

    function AlertIcon() {
      return h('svg', { viewBox: '0 0 16 16', width: 13, height: 13, style: { flex: 'none', color: '#ef4444' }, 'aria-hidden': true },
        h('circle', { cx: 8, cy: 8, r: 6.5, fill: 'none', stroke: 'currentColor', strokeWidth: 1.5 }),
        h('line', { x1: 8, y1: 4.2, x2: 8, y2: 8.6, stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' }),
        h('circle', { cx: 8, cy: 11.3, r: 0.85, fill: 'currentColor' }),
      )
    }

    function withSeparators(text) {
      const [int, dec] = String(text).split('.')
      return int.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (dec !== undefined ? `.${dec}` : '')
    }

    function money(currency, amount) {
      const value = Number(amount)
      const text = Number.isFinite(value) ? withSeparators(value.toFixed(2)) : String(amount)
      if (currency === 'CNY') return `¥${text}`
      if (currency === 'USD') return `$${text}`
      return `${currency} ${text}`
    }

    // 胶囊用：大数压缩成 K/M/B，避免把状态栏撑坏。
    function compactMoney(currency, amount) {
      const value = Number(amount)
      if (!Number.isFinite(value)) return `${currency} ${amount}`
      const abs = Math.abs(value)
      const symbol = currency === 'CNY' ? '¥' : currency === 'USD' ? '$' : `${currency} `
      if (abs >= 1e9) return `${symbol}${(value / 1e9).toFixed(2)}B`
      if (abs >= 1e6) return `${symbol}${(value / 1e6).toFixed(2)}M`
      if (abs >= 1e4) return `${symbol}${(value / 1e3).toFixed(2)}K`
      return `${symbol}${value.toFixed(2)}`
    }

    function cny(value) {
      const number = Number(value)
      if (!Number.isFinite(number)) return '¥—'
      return `¥${withSeparators(Math.abs(number) < 1 ? number.toFixed(4) : number.toFixed(2))}`
    }

    function balanceLabel(balance, t) {
      if (balance === null || balance === undefined) return ''
      if (balance.status === 'no-key') return t('noKey')
      if (balance.status === 'error') return t('balanceError')
      const list = balance.balances || []
      if (list.length === 0) return t('balanceEmpty')
      const preferred = list.find(item => item.currency === 'CNY') || list[0]
      return compactMoney(preferred.currency, preferred.totalBalance)
    }

    function balanceIsLow(balance, low) {
      if (balance === null || balance === undefined || balance.status !== 'ok') return false
      if (balance.isAvailable === false) return true
      const cnyLimit = low !== null && low !== undefined && Number.isFinite(Number(low.cny)) ? Number(low.cny) : LOW_CNY
      const usdLimit = low !== null && low !== undefined && Number.isFinite(Number(low.usd)) ? Number(low.usd) : LOW_USD
      if (cnyLimit > 0) {
        const cnyEntry = (balance.balances || []).find(item => item.currency === 'CNY')
        if (cnyEntry && Number(cnyEntry.totalBalance) < cnyLimit) return true
      }
      if (usdLimit > 0) {
        const usdEntry = (balance.balances || []).find(item => item.currency === 'USD')
        if (usdEntry && Number(usdEntry.totalBalance) < usdLimit) return true
      }
      return false
    }

    function toppedUpInfo(balance) {
      if (balance === null || balance === undefined || balance.status !== 'ok') return null
      for (const currency of ['CNY', 'USD']) {
        const entry = (balance.balances || []).find(item => item.currency === currency)
        if (entry) return { currency, text: money(currency, entry.toppedUpBalance) }
      }
      return null
    }

    function modelColor(model) {
      const name = String(model || '').toLowerCase()
      if (name.indexOf('flash') >= 0) return '#fbbf24'
      if (name.indexOf('pro') >= 0) return '#fb923c'
      return '#60a5fa'
    }

    function remainingMs(status) {
      if (status === null || status.nextTransitionMs === null || status.nextTransitionMs === undefined) return null
      const elapsed = status.refreshedAt ? Date.now() - status.refreshedAt : 0
      return Math.max(0, status.nextTransitionMs - elapsed)
    }

    function formatCountdown(ms, t) {
      if (ms === null || ms === undefined) return ''
      const totalMinutes = Math.max(1, Math.round(ms / 60000))
      const days = Math.floor(totalMinutes / 1440)
      const hours = Math.floor((totalMinutes % 1440) / 60)
      const minutes = totalMinutes % 60
      if (days > 0) return `${days} ${t('days')} ${hours} ${t('hours')}`
      if (hours > 0) return `${hours} ${t('hours')} ${minutes} ${t('minutes')}`
      return `${minutes} ${t('minutes')}`
    }

    function useAnchorPop() {
      const [open, setOpen] = useState(false)
      const [pos, setPos] = useState({ bottom: 0, left: 0 })
      const anchorRef = useRef(null)
      const panelRef = useRef(null)
      const measure = () => {
        const el = anchorRef.current
        if (el === null) return
        const rect = el.getBoundingClientRect()
        setPos({
          bottom: Math.max(8, window.innerHeight - rect.top + 8),
          left: Math.max(8, Math.min(rect.left, window.innerWidth - 340)),
        })
      }
      useEffect(() => {
        if (!open) return
        const onKey = (e) => { if (e.key === 'Escape') setOpen(false) }
        const onPointer = (e) => {
          if (e.target instanceof Node
            && anchorRef.current?.contains(e.target) !== true
            && panelRef.current?.contains(e.target) !== true) setOpen(false)
        }
        document.addEventListener('keydown', onKey)
        document.addEventListener('pointerdown', onPointer, true)
        return () => {
          document.removeEventListener('keydown', onKey)
          document.removeEventListener('pointerdown', onPointer, true)
        }
      }, [open])
      const toggle = () => {
        if (open) { setOpen(false); return }
        setOpen(true)
      }
      return { open, toggle, measure, pos, anchorRef, panelRef }
    }

    function renderDialog(status, t) {
      const byModel = status.byModel || []
      const sum = byModel.reduce((total, item) => total + (Number(item.cost) || 0), 0)
      const bar = sum > 0
        ? h('div', { className: 'api-balance-bar' }, byModel.map(item => h('span', {
          key: item.model,
          className: 'api-balance-bar-seg',
          style: {
            width: `${((Number(item.cost) || 0) / sum * 100).toFixed(3)}%`,
            backgroundColor: modelColor(item.model),
          },
        })))
        : null
      const legend = byModel.length > 0
        ? byModel.map(item => h('div', { className: 'api-balance-row', key: item.model },
          h('span', { className: 'api-balance-legend' },
            h('span', { className: 'api-balance-square', style: { backgroundColor: modelColor(item.model) } }),
            h('span', {}, item.model === 'unknown' ? t('unknownModel') : item.model),
          ),
          h('em', { className: 'api-balance-value' }, cny(item.cost)),
        ))
        : [h('div', { className: 'api-balance-row', key: 'empty' }, h('span', {}, t('noUsage')))]

      const label = status.period === 'peak' ? t('peak') : t('valley')
      const countdown = formatCountdown(remainingMs(status), t)
      const topped = toppedUpInfo(status.balance)

      return h('div', {},
        h('div', { className: 'api-balance-title' },
          h('span', {}, `${label}${t('remaining')}`),
          countdown ? h('b', {}, countdown) : null,
        ),
        topped !== null ? h('div', { className: 'api-balance-row api-balance-strong' },
          h('span', {}, `${t('topUpBalance')} (${topped.currency})`),
          h('em', {}, topped.text),
        ) : null,
        h('div', { className: 'api-balance-row', style: { marginTop: '2px' } },
          h('span', {}, t('spendTitle')),
          h('em', { className: 'api-balance-value' }, cny(status.todaySpend)),
        ),
        bar,
        legend,
        status.alertEnabled === false ? h('div', {},
          h('div', { className: 'api-balance-rule', style: { margin: '8px 0 6px' } }),
          h('div', { className: 'api-balance-alert' },
            h(AlertIcon),
            h('span', { className: 'api-balance-alert-text' }, t('alertOff')),
            h('a', {
              className: 'api-balance-settings',
              href: 'https://platform.deepseek.com/usage',
              target: '_blank',
              rel: 'noreferrer',
              onClick: event => event.stopPropagation(),
            }, t('settings')),
          ),
        ) : null,
      )
    }

    function BalancePill({ t, sessionId }) {
      const [status, setStatus] = useState(null)
      const pop = useAnchorPop()
      const [hover, setHover] = useState(false)
      const [tip, setTip] = useState({ bottom: 0, left: 0 })

      useEffect(() => {
        let alive = true
        let timer
        const query = sessionId ? `?session=${encodeURIComponent(sessionId)}` : ''
        const load = () => {
          fetch(`/api-balance/status.json${query}`)
            .then(response => response.json())
            .then((value) => { if (alive) setStatus(value) })
            .catch(() => { /* keep last value; retry next tick */ })
        }
        load()
        timer = setInterval(load, POLL_MS)
        return () => { alive = false; clearInterval(timer) }
      }, [sessionId])

      const enter = () => {
        const el = pop.anchorRef.current
        if (el !== null) {
          const rect = el.getBoundingClientRect()
          setTip({
            bottom: Math.max(8, window.innerHeight - rect.top + 8),
            left: Math.max(8, Math.min(rect.left, window.innerWidth - 340)),
          })
        }
        setHover(true)
      }
      const leave = () => setHover(false)
      const toggle = () => { pop.measure(); pop.toggle() }

      if (status === null) return null

      const balanceText = balanceLabel(status.balance, t)
      const periodText = status.period === 'peak' ? t('peak') : t('valley')
      const dotColor = status.period === 'peak' ? '#f59e0b' : '#10b981'
      const low = balanceIsLow(status.balance, status.lowBalance)
      const countdown = formatCountdown(remainingMs(status), t)
      const reading = `${balanceText} · ${periodText}`

      return h('span', { className: 'api-balance-pill' },
        h('button', {
          ref: pop.anchorRef,
          type: 'button',
          className: 'api-balance-btn',
          style: low ? { color: '#ef4444' } : undefined,
          onClick: toggle,
          onMouseEnter: enter,
          onMouseLeave: leave,
          'aria-haspopup': 'dialog',
          'aria-expanded': pop.open ? 'true' : 'false',
          'aria-label': reading,
        },
          h(CoinIcon),
          h('span', { className: 'api-balance-label' }, balanceText),
          h('span', { className: 'api-balance-sep' }, '·'),
          h('span', { className: 'api-balance-dot', style: { backgroundColor: dotColor } }),
          h('span', { className: 'api-balance-label' }, periodText),
        ),
        !pop.open && hover && countdown ? createPortal(
          h('div', { className: 'api-balance-tip', style: { bottom: tip.bottom, left: tip.left } }, `${t('switchIn')} ${countdown}`),
          document.body,
        ) : null,
        pop.open ? createPortal(
          h('div', {
            ref: pop.panelRef,
            className: 'api-balance-panel',
            role: 'dialog',
            'aria-label': reading,
            style: { bottom: pop.pos.bottom, left: pop.pos.left },
          }, renderDialog(status, t)),
          document.body,
        ) : null,
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => {
          const style = document.createElement('style')
          style.setAttribute('data-plugin', CACHE_KEY)
          style.textContent = CSS
          document.head.appendChild(style)
          return () => { style.remove() }
        }, 'api-balance: styles')
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'api-balance: locale')
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'api-balance',
          order: 60,
          locale: NS,
          inject: (sessionId) => ({ sessionId }),
        }, BalancePill))
      },
    }
  },
})
