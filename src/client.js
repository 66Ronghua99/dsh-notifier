// Client half of DSH Notifier.
//
// Two jobs:
//   1. poll the Host for click hand-offs (a notification click queued a session)
//      and for the reminder inbox, then navigate with uiWorkspace.openSession();
//   2. render the whale doll in `shell.overlay`: it bobs in the corner, pops a
//      speech bubble when a session finishes, and opens a per-session reminder
//      list whose rows jump straight to that session.
window.__ModuleLoader__.load({
  id: '@local/dsh-notifier',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useRef } = React

    const CLIENT_BUILD = '0.1.4'
    const POLL_INTERVAL_MS = 1500
    const BUBBLE_VISIBLE_MS = 9000
    const POP_VISIBLE_MS = 900
    const POSITION_KEY = 'dsh-notifier-whale-position'
    const DOLL_SIZE = 96
    const DOLL_SIZE_MIN = 48
    const DOLL_SIZE_MAX = 220
    const SIZE_KEY = 'dsh-notifier-whale-size'

    const STRINGS = {
      zh: {
        list: '会话提醒',
        empty: '没有提醒，安静得很。',
        markAll: '全部已读',
        close: '关闭',
        untitled: '未命名会话',
        completed: '已完成',
        error: '出错了',
        'max-tokens': '已停止',
        blocked: '已中断',
        aborted: '已中断',
        interrupted: '已中断',
        bubbleDone: (title) => `「${title}」答完啦`,
        bubbleError: (title) => `「${title}」出错了`,
        bubbleHint: '点击直接切到该会话 · 点玩偶看全部',
        unread: (count) => `${count} 条未读`,
        justNow: '刚刚',
        minutesAgo: (count) => `${count} 分钟前`,
        hoursAgo: (count) => `${count} 小时前`,
        daysAgo: (count) => `${count} 天前`,
        open: '打开会话',
        whale: 'DSH 提醒：点击查看未查看的会话',
        size: '玩偶尺寸',
        smaller: '缩小玩偶',
        bigger: '放大玩偶',
        muted: '通知已静音',
      },
      en: {
        list: 'Session reminders',
        empty: 'No reminders. All quiet.',
        markAll: 'Mark all read',
        close: 'Close',
        untitled: 'Untitled session',
        completed: 'Finished',
        error: 'Failed',
        'max-tokens': 'Stopped',
        blocked: 'Blocked',
        aborted: 'Interrupted',
        interrupted: 'Interrupted',
        bubbleDone: (title) => `“${title}” is done`,
        bubbleError: (title) => `“${title}” failed`,
        bubbleHint: 'Click to switch · the doll lists every session',
        unread: (count) => `${count} unread`,
        justNow: 'just now',
        minutesAgo: (count) => `${count} min ago`,
        hoursAgo: (count) => `${count} h ago`,
        daysAgo: (count) => `${count} d ago`,
        open: 'Open session',
        whale: 'DSH reminders: click to review sessions',
        size: 'Doll size',
        smaller: 'Smaller doll',
        bigger: 'Bigger doll',
        muted: 'Notifications muted',
      },
    }

    function apply(ctx) {
      const uiWorkspace = ctx.get('uiWorkspace')
      const slots = ctx.get('slots')
      if (uiWorkspace === undefined || slots === undefined) return

      const locale = ctx.get('locale')
      const listeners = new Set()
      const state = {
        reminders: [],
        unread: 0,
        muted: false,
        panelOpen: false,
        banner: null,
        popping: false,
        dollSize: loadDollSize() ?? 0,
      }

      function emit() {
        for (const listener of [...listeners]) {
          try {
            listener()
          } catch {
            // A crashing subscriber must not stop the poller.
          }
        }
      }

      function setState(patch) {
        Object.assign(state, patch)
        emit()
      }

      function language() {
        const active = locale?.getLocale?.().active
        return typeof active === 'string' && active.toLowerCase().startsWith('zh') ? 'zh' : 'en'
      }

      function t() {
        return STRINGS[language()]
      }

      let disposed = false
      let inFlight = false
      let lastSeenAt = 0
      /** Read directives not yet accepted by the Host. */
      const pendingRead = new Set()
      let pendingReadAll = false
      let bannerTimer = 0
      let popTimer = 0

      // MARK: navigation

      function reportOpened(sessionId, source, title) {
        try {
          const query = new URLSearchParams({ session: sessionId, source })
          if (title) query.set('title', title.slice(0, 80))
          fetch(`/dsh-notifier/opened?${query.toString()}`, { cache: 'no-store' }).catch(() => {})
        } catch {
          // Diagnostics only.
        }
      }

      function openSession(sessionId, source = 'pending', title = '') {
        try {
          window.focus()
        } catch {
          // Focus may be refused outside a user gesture; navigation still works.
        }
        try {
          uiWorkspace.openSession(sessionId)
          reportOpened(sessionId, source, title)
        } catch (error) {
          console.error(`[dsh-notifier] openSession failed (${source})`, error)
        }
      }

      /**
       * Queue a read directive. It rides the next state poll instead of a
       * separate write request, so marking read works wherever the poll works.
       */
      function markRead(sessionId) {
        if (sessionId) pendingRead.add(sessionId)
        else pendingReadAll = true
        poll()
      }

      function readLocally(sessionId) {
        const reminders = state.reminders.map((reminder) =>
          !sessionId || reminder.sessionId === sessionId ? { ...reminder, read: true } : reminder,
        )
        const unread = reminders.reduce((count, reminder) => count + (reminder.read ? 0 : 1), 0)
        setState({ reminders, unread })
      }

      // MARK: polling

      function noteNewReminders(reminders) {
        const latest = reminders[0]
        if (latest === undefined) return
        if (lastSeenAt === 0) {
          lastSeenAt = latest.at
          return
        }
        if (latest.at <= lastSeenAt) return
        lastSeenAt = latest.at
        const copy = t()
        const title = latest.title || copy.untitled
        const text = latest.kind === 'error' ? copy.bubbleError(title) : copy.bubbleDone(title)
        setState({
          banner: { text, hint: copy.bubbleHint, sessionId: latest.sessionId },
          popping: true,
          // A fresh reminder reopens the list only if the user was already browsing it.
        })
        clearTimeout(bannerTimer)
        bannerTimer = setTimeout(() => setState({ banner: null }), BUBBLE_VISIBLE_MS)
        clearTimeout(popTimer)
        popTimer = setTimeout(() => setState({ popping: false }), POP_VISIBLE_MS)
      }

      async function poll() {
        if (disposed || inFlight) return
        inFlight = true
        const queuedAll = pendingReadAll
        const queuedSessions = [...pendingRead]
        pendingReadAll = false
        pendingRead.clear()
        try {
          const focused = document.hasFocus() ? '1' : '0'
          const surface = location.protocol === 'dsh-app:' ? 'desktop' : 'web'
          const active = locale?.getLocale?.().active
          const localeParam = typeof active === 'string' ? `&locale=${encodeURIComponent(active)}` : ''
          const readParam = queuedAll
            ? '&readAll=1'
            : queuedSessions.map((id) => `&read=${encodeURIComponent(id)}`).join('')
          const response = await fetch(
            `/dsh-notifier/state?focused=${focused}&surface=${surface}&build=${CLIENT_BUILD}${localeParam}${readParam}`,
            { cache: 'no-store' },
          )
          if (!response.ok) {
            // Keep the directives for the next tick instead of dropping them.
            if (queuedAll) pendingReadAll = true
            for (const sessionId of queuedSessions) pendingRead.add(sessionId)
            return
          }
          const payload = await response.json()
          // Only the newest hand-off wins: an older queued click must never
          // override a session the user just opened.
          const pendingItems = (Array.isArray(payload?.pending) ? payload.pending : []).filter(
            (item) => typeof item?.sessionId === 'string' && item.sessionId,
          )
          const newest = pendingItems[pendingItems.length - 1]
          if (newest) openSession(newest.sessionId, 'pending', newest.title ?? '')
          const reminders = Array.isArray(payload?.reminders) ? payload.reminders : []
          noteNewReminders(reminders)
          const patch = {
            reminders,
            unread: Number(payload?.unread) || 0,
            muted: payload?.muted === true,
          }
          const serverSize = Number(payload?.dollSize) || DOLL_SIZE
          if (!state.dollSize) patch.dollSize = clamp(serverSize, DOLL_SIZE_MIN, DOLL_SIZE_MAX)
          setState(patch)
        } catch {
          // The Host may be restarting; keep the directives for the next tick.
          if (queuedAll) pendingReadAll = true
          for (const sessionId of queuedSessions) pendingRead.add(sessionId)
        } finally {
          inFlight = false
        }
      }

      ctx.effect(() => {
        const timer = setInterval(poll, POLL_INTERVAL_MS)
        const wake = () => {
          if (document.visibilityState === 'visible') poll()
        }
        document.addEventListener('visibilitychange', wake)
        window.addEventListener('focus', wake)
        poll()
        return () => {
          disposed = true
          clearInterval(timer)
          clearTimeout(bannerTimer)
          clearTimeout(popTimer)
          document.removeEventListener('visibilitychange', wake)
          window.removeEventListener('focus', wake)
        }
      }, 'dsh-notifier: state poller')

      ctx.effect(() => ctx.on('locale/change', () => emit()), 'dsh-notifier: locale listener')

      // MARK: whale

      function Whale() {
        const [, force] = useState(0)
        const [position, setPosition] = useState(loadPosition)
        const [artReady, setArtReady] = useState(false)
        const rootRef = useRef(null)
        const dragRef = useRef({ moved: false })
        const positionRef = useRef(position)
        const copy = t()
        // The panel is an inbox: handled (read) reminders leave it instead of piling up.
        const groups = groupReminders(state.reminders.filter((reminder) => reminder.read !== true))
        const whaleSize = clamp(state.dollSize || DOLL_SIZE, DOLL_SIZE_MIN, DOLL_SIZE_MAX)

        useEffect(() => {
          const listener = () => force((tick) => tick + 1)
          listeners.add(listener)
          return () => {
            listeners.delete(listener)
          }
        }, [])

        useEffect(() => {
          if (!state.panelOpen) return undefined
          const onPointerDown = (event) => {
            if (rootRef.current && !rootRef.current.contains(event.target)) setState({ panelOpen: false })
          }
          const onKeyDown = (event) => {
            if (event.key === 'Escape') setState({ panelOpen: false })
          }
          document.addEventListener('pointerdown', onPointerDown)
          document.addEventListener('keydown', onKeyDown)
          return () => {
            document.removeEventListener('pointerdown', onPointerDown)
            document.removeEventListener('keydown', onKeyDown)
          }
        }, [state.panelOpen])

        function resizeDoll(delta) {
          const next = clamp(whaleSize + delta, DOLL_SIZE_MIN, DOLL_SIZE_MAX)
          setState({ dollSize: next })
          saveDollSize(next)
        }

        function togglePanel() {
          if (dragRef.current.moved) {
            dragRef.current.moved = false
            return
          }
          setState({ panelOpen: !state.panelOpen, banner: null })
        }

        function onPointerDown(event) {
          if (event.button !== 0) return
          const startX = event.clientX
          const startY = event.clientY
          positionRef.current = { ...position }
          const start = { ...position }
          dragRef.current = { moved: false, startX, startY, start }
          event.currentTarget.setPointerCapture?.(event.pointerId)
        }

        function onPointerMove(event) {
          const drag = dragRef.current
          if (drag?.start === undefined) return
          const dx = event.clientX - drag.startX
          const dy = event.clientY - drag.startY
          if (!drag.moved && Math.hypot(dx, dy) < 4) return
          drag.moved = true
          const next = {
            right: clamp(drag.start.right - dx, 4, window.innerWidth - whaleSize - 4),
            bottom: clamp(drag.start.bottom - dy, 4, window.innerHeight - whaleSize - 4),
          }
          positionRef.current = next
          setPosition(next)
        }

        function onPointerUp() {
          const drag = dragRef.current
          dragRef.current = { moved: drag?.moved === true }
          if (drag?.start !== undefined) savePosition(positionRef.current)
        }

        function openBannerSession() {
          const banner = state.banner
          setState({ panelOpen: false, banner: null })
          if (typeof banner?.sessionId !== 'string' || banner.sessionId === '') return
          openSession(banner.sessionId, 'bubble', banner.text ?? '')
          readLocally(banner.sessionId)
          markRead(banner.sessionId)
        }

        function openGroup(group) {
          openSession(group.sessionId, 'reminder', group.title)
          readLocally(group.sessionId)
          markRead(group.sessionId)
          setState({ panelOpen: false, banner: null })
        }

        function markAll() {
          readLocally('')
          markRead('')
        }

        const panel =
          state.panelOpen === true
            ? h(
                'div',
                { className: 'dsn-panel', role: 'dialog', 'aria-label': copy.list },
                h(
                  'div',
                  { className: 'dsn-panel-head' },
                  h('span', { className: 'dsn-panel-title' }, copy.list),
                  state.unread > 0 ? h('span', { className: 'dsn-panel-count' }, copy.unread(state.unread)) : null,
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dsn-link',
                      onClick: markAll,
                      disabled: state.unread === 0,
                    },
                    copy.markAll,
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dsn-close',
                      'aria-label': copy.close,
                      onClick: () => setState({ panelOpen: false }),
                    },
                    '×',
                  ),
                ),
                groups.length === 0
                  ? h('div', { className: 'dsn-empty' }, copy.empty)
                  : h(
                      'div',
                      { className: 'dsn-list' },
                      groups.map((group) =>
                        h(
                          'button',
                          {
                            key: group.sessionId,
                            type: 'button',
                            className: 'dsn-row',
                            title: copy.open,
                            onClick: () => openGroup(group),
                          },
                          h('span', { className: 'dsn-dot' + (group.unread ? ' is-on' : '') }),
                          h(
                            'span',
                            { className: 'dsn-row-main' },
                            h('span', { className: 'dsn-row-title' }, group.title || copy.untitled),
                            h(
                              'span',
                              { className: 'dsn-row-meta' },
                              [group.where, subtitleOf(group.kind, copy), relativeTime(group.at, copy)]
                                .filter(Boolean)
                                .join(' · '),
                              group.count > 1 ? ` · ×${group.count}` : '',
                            ),
                          ),
                        ),
                      ),
                    ),
                h(
                  'div',
                  { className: 'dsn-foot' },
                  h('span', { className: 'dsn-foot-label' }, copy.size),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dsn-step',
                      'aria-label': copy.smaller,
                      title: copy.smaller,
                      onClick: () => resizeDoll(-8),
                    },
                    '−',
                  ),
                  h('span', { className: 'dsn-step-value' }, `${whaleSize}px`),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dsn-step',
                      'aria-label': copy.bigger,
                      title: copy.bigger,
                      onClick: () => resizeDoll(8),
                    },
                    '＋',
                  ),
                ),
              )
            : null

        const bubble =
          state.panelOpen !== true && state.banner !== null
            ? h(
                'button',
                {
                  type: 'button',
                  className: 'dsn-bubble',
                  onClick: openBannerSession,
                },
                h(
                  'svg',
                  {
                    className: 'dsn-cloud',
                    viewBox: '0 0 300 124',
                    width: 300,
                    height: 124,
                    'aria-hidden': true,
                    focusable: false,
                  },
                  h('circle', { cx: 250, cy: 100, r: 15, fill: '#ffffff', stroke: '#203170', 'stroke-width': 5 }),
                  h('circle', { cx: 271, cy: 117, r: 9, fill: '#ffffff', stroke: '#203170', 'stroke-width': 5 }),
                  h('rect', {
                    x: 9,
                    y: 9,
                    width: 282,
                    height: 78,
                    rx: 26,
                    fill: '#ffffff',
                    stroke: '#203170',
                    'stroke-width': 5,
                  }),
                ),
                h(
                  'span',
                  { className: 'dsn-bubble-body' },
                  h('span', { className: 'dsn-bubble-text' }, state.banner.text),
                  h('span', { className: 'dsn-bubble-hint' }, state.banner.hint),
                ),
              )
            : null

        return h(
          'div',
          {
            ref: rootRef,
            className: 'dsn-root',
            style: { right: `${position.right}px`, bottom: `${position.bottom}px` },
          },
          h('style', null, WHALE_CSS),
          bubble,
          panel,
          h(
            'button',
            {
              type: 'button',
              style: { width: `${whaleSize}px`, height: `${whaleSize}px` },
              className:
                'dsn-whale' +
                (state.popping ? ' is-popping' : '') +
                (state.unread > 0 ? ' is-alert' : '') +
                (state.muted ? ' is-muted' : ''),
              title: copy.whale,
              'aria-label': copy.whale,
              onPointerDown,
              onPointerMove,
              onPointerUp,
              onClick: togglePanel,
            },
            h('img', {
              className: 'dsn-art',
              src: '/dsh-notifier/art',
              alt: '',
              'aria-hidden': true,
              draggable: false,
              onLoad: () => setArtReady(true),
              onError: () => setArtReady(false),
              style: { opacity: artReady ? 1 : 0 },
            }),
            artReady ? null : whaleSvg(),
            state.unread > 0
              ? h('span', { className: 'dsn-badge' }, state.unread > 9 ? '9+' : String(state.unread))
              : null,
          ),
        )
      }

      slots.inject('shell.overlay', () =>
        slots.register({ name: 'shell.overlay', id: 'dsh-notifier.whale', order: 30 }, Whale),
      )
    }

    // MARK: helpers

    function clamp(value, min, max) {
      return Math.min(Math.max(value, min), max)
    }

    function loadPosition() {
      const fallback = { right: 18, bottom: 210 }
      try {
        const raw = window.localStorage.getItem(POSITION_KEY)
        if (!raw) return fallback
        const parsed = JSON.parse(raw)
        if (typeof parsed?.right !== 'number' || typeof parsed?.bottom !== 'number') return fallback
        return {
          right: clamp(parsed.right, 4, Math.max(4, window.innerWidth - 62)),
          bottom: clamp(parsed.bottom, 4, Math.max(4, window.innerHeight - 62)),
        }
      } catch {
        return fallback
      }
    }

    function loadDollSize() {
      try {
        const value = Number(window.localStorage.getItem(SIZE_KEY))
        return Number.isFinite(value) && value >= DOLL_SIZE_MIN && value <= DOLL_SIZE_MAX ? value : null
      } catch {
        return null
      }
    }

    function saveDollSize(size) {
      try {
        window.localStorage.setItem(SIZE_KEY, String(size))
      } catch {
        // Resizing still applies for this session.
      }
    }

    function savePosition(position) {
      try {
        window.localStorage.setItem(POSITION_KEY, JSON.stringify(position))
      } catch {
        // A locked-down storage leaves the position at its default.
      }
    }

    function groupReminders(reminders) {
      const groups = new Map()
      for (const reminder of reminders) {
        const sessionId = typeof reminder?.sessionId === 'string' ? reminder.sessionId : ''
        if (!sessionId) continue
        const current = groups.get(sessionId)
        if (current === undefined) {
          groups.set(sessionId, {
            sessionId,
            title: reminder.title ?? '',
            where: reminder.where ?? '',
            kind: reminder.kind ?? 'completed',
            at: Number(reminder.at) || 0,
            count: 1,
            unread: reminder.read !== true,
          })
          continue
        }
        current.count += 1
        current.unread = current.unread || reminder.read !== true
        if ((Number(reminder.at) || 0) > current.at) {
          current.at = Number(reminder.at) || 0
          current.title = reminder.title ?? current.title
          current.kind = reminder.kind ?? current.kind
        }
      }
      return [...groups.values()].sort((a, b) => b.at - a.at).slice(0, 12)
    }

    function subtitleOf(kind, copy) {
      const key = typeof kind === 'string' ? kind : 'completed'
      return copy[key] ?? copy.completed
    }

    function relativeTime(at, copy) {
      const elapsed = Date.now() - (Number(at) || 0)
      if (elapsed < 60_000) return copy.justNow
      if (elapsed < 3_600_000) return copy.minutesAgo(Math.floor(elapsed / 60_000))
      if (elapsed < 86_400_000) return copy.hoursAgo(Math.floor(elapsed / 3_600_000))
      return copy.daysAgo(Math.floor(elapsed / 86_400_000))
    }

    function whaleSvg() {
      return h(
        'svg',
        { viewBox: '0 0 72 72', width: 58, height: 58, 'aria-hidden': true, focusable: false },
        h('path', { d: 'M17 41c-6-4-11-11-12-13 4 1 9 5 13 8z', fill: '#4a63b0' }),
        h('path', { d: 'M17 41c-6 4-11 11-12 13 4-1 9-5 13-8z', fill: '#4a63b0' }),
        h('ellipse', { cx: 38, cy: 41, rx: 22, ry: 17, fill: '#4a63b0' }),
        h('ellipse', { cx: 41, cy: 48, rx: 16, ry: 9, fill: '#dbe4f8' }),
        h('path', { d: 'M36 24c0-4-2-6-2-6s3 1 4 4c1-3 4-4 4-4s-2 2-2 6z', fill: '#8fb0ea' }),
        h('circle', { cx: 30, cy: 16, r: 1.4, fill: '#a9c2ef' }),
        h('circle', { cx: 42, cy: 14, r: 1, fill: '#a9c2ef' }),
        h('circle', { cx: 52, cy: 38, r: 4, fill: '#1d2a52' }),
        h('circle', { cx: 53.4, cy: 36.6, r: 1.4, fill: '#ffffff' }),
        h('path', {
          d: 'M50 45c2 2 5 2 6.5 0',
          fill: 'none',
          stroke: '#1d2a52',
          'stroke-width': 1.8,
          'stroke-linecap': 'round',
        }),
        h('ellipse', { cx: 44, cy: 44, rx: 3.2, ry: 1.9, fill: '#f0a8b8', opacity: 0.75 }),
      )
    }

    const WHALE_CSS = `
.dsn-root {
  position: fixed;
  z-index: 60;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 8px;
  pointer-events: none;
  font-family: var(--dsw-font-family, inherit);
  color-scheme: inherit;
}
.dsn-whale {
  position: relative;
  flex: 0 0 auto;
  padding: 0;
  border: 0;
  background: transparent;
  cursor: grab;
  pointer-events: auto;
  touch-action: none;
  -webkit-app-region: no-drag;
  animation: dsn-bob 4.5s ease-in-out infinite;
  filter: drop-shadow(0 4px 10px rgba(20, 33, 74, 0.22));
  transition: transform 0.15s ease;
}
.dsn-whale:hover { transform: scale(1.04); }
.dsn-whale:active { cursor: grabbing; }
.dsn-whale:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 3px; border-radius: 50%; }
.dsn-whale.is-popping { animation: dsn-bob 4.5s ease-in-out infinite, dsn-pop 0.85s ease; }
.dsn-whale.is-alert { filter: drop-shadow(0 4px 12px rgba(224, 161, 68, 0.45)); }
.dsn-whale.is-muted { opacity: 0.72; }
.dsn-badge {
  position: absolute;
  top: -2px;
  right: -2px;
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  border-radius: 9px;
  background: #e0a144;
  color: #241a06;
  font-size: 11px;
  font-weight: 700;
  line-height: 18px;
  text-align: center;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.25);
}
.dsn-bubble {
  position: relative;
  width: 300px;
  height: 124px;
  margin-right: 2px;
  padding: 0;
  border: 0;
  background: none;
  text-align: left;
  cursor: pointer;
  pointer-events: auto;
  -webkit-app-region: no-drag;
  animation: dsn-cloud-in 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
  filter: drop-shadow(0 8px 18px rgba(20, 33, 74, 0.18));
}
.dsn-cloud {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}
.dsn-bubble-body {
  position: absolute;
  left: 26px;
  right: 42px;
  top: 20px;
  height: 52px;
  display: flex;
  flex-direction: column;
  justify-content: center;
}
.dsn-bubble-text {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  font-size: 13px;
  line-height: 18px;
  font-weight: 600;
  color: #35477f;
}
.dsn-bubble-hint {
  display: block;
  margin-top: 3px;
  font-size: 10.5px;
  line-height: 15px;
  color: #6b7cb3;
}
.dsn-art {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: contain;
  pointer-events: none;
  -webkit-user-drag: none;
  transition: opacity 0.2s ease;
}
.dsn-panel {
  pointer-events: auto;
  width: 288px;
  max-width: calc(100vw - 32px);
  max-height: min(360px, calc(100vh - 140px));
  display: flex;
  flex-direction: column;
  padding: 10px 10px 8px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 16px;
  background: var(--dsw-alias-bg-overlay);
  box-shadow: 0 16px 40px rgba(15, 23, 42, 0.22);
  -webkit-app-region: no-drag;
  animation: dsn-rise 0.18s ease-out;
}
.dsn-panel-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 2px 8px;
}
.dsn-panel-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary);
}
.dsn-panel-count {
  font-size: 11px;
  color: var(--dsw-alias-brand-primary);
}
.dsn-link {
  margin-left: auto;
  padding: 0;
  border: 0;
  background: none;
  font-size: 11px;
  color: var(--dsw-alias-brand-primary);
  cursor: pointer;
}
.dsn-link:disabled { color: var(--dsw-alias-state-idle-primary); cursor: default; }
.dsn-close {
  width: 20px;
  height: 20px;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: none;
  color: var(--dsw-alias-label-secondary);
  font-size: 15px;
  line-height: 18px;
  cursor: pointer;
}
.dsn-close:hover { background: var(--dsw-alias-bg-layer-2); }
.dsn-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  overflow-y: auto;
}
.dsn-row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  width: 100%;
  padding: 7px 8px;
  border: 0;
  border-radius: 10px;
  background: none;
  text-align: left;
  cursor: pointer;
  -webkit-app-region: no-drag;
}
.dsn-row:hover { background: var(--dsw-alias-bg-layer-2); }
.dsn-dot {
  flex: 0 0 auto;
  width: 7px;
  height: 7px;
  margin-top: 6px;
  border-radius: 50%;
  background: var(--dsw-alias-border-l2);
}
.dsn-dot.is-on { background: var(--dsw-alias-brand-primary); }
.dsn-row-main { display: flex; flex-direction: column; min-width: 0; }
.dsn-row-title {
  font-size: 12.5px;
  line-height: 17px;
  color: var(--dsw-alias-label-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dsn-row-meta {
  font-size: 11px;
  line-height: 15px;
  color: var(--dsw-alias-label-secondary);
}
.dsn-foot {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 6px;
  padding: 7px 4px 2px;
  border-top: 1px solid var(--dsw-alias-border-l1);
}
.dsn-foot-label {
  font-size: 11px;
  color: var(--dsw-alias-label-secondary);
}
.dsn-step {
  width: 20px;
  height: 20px;
  padding: 0;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 6px;
  background: none;
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  line-height: 17px;
  cursor: pointer;
}
.dsn-step:hover { background: var(--dsw-alias-bg-layer-2); }
.dsn-step-value {
  min-width: 42px;
  font-size: 11px;
  color: var(--dsw-alias-label-secondary);
  text-align: center;
}
.dsn-empty {
  padding: 14px 10px 16px;
  font-size: 12px;
  color: var(--dsw-alias-label-secondary);
  text-align: center;
}
@keyframes dsn-bob {
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(-5px); }
}
@keyframes dsn-pop {
  0% { transform: scale(1); }
  30% { transform: scale(1.18); }
  60% { transform: scale(0.96); }
  100% { transform: scale(1); }
}
@keyframes dsn-rise {
  from { opacity: 0; transform: translateY(6px); }
  to { opacity: 1; transform: translateY(0); }
}
@keyframes dsn-cloud-in {
  0% { opacity: 0; transform: scale(0.7) translateY(8px); }
  70% { opacity: 1; }
  100% { opacity: 1; transform: scale(1) translateY(0); }
}
@media (prefers-reduced-motion: reduce) {
  .dsn-whale, .dsn-whale.is-popping { animation: none; }
  .dsn-bubble, .dsn-panel { animation: none; }
}
`

    return { inject: ['uiWorkspace', 'slots'], apply }
  },
})
