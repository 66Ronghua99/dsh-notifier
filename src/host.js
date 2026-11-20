/**
 * Host half of DSH Notifier.
 *
 * Watches durable `turn/end` events, shows one macOS notification through the
 * bundled helper app (`helper/build/DSHNotifier.app`), and serves the small
 * hand-off route the Client half polls:
 *
 *   GET  /dsh-notifier/pending?focused=0|1  take the sessions a notification click queued
 *   GET  /dsh-notifier/opened?session=ID    record that the page navigated to a session
 *   POST /dsh-notifier/navigate             queue one session without a click (testing, integrations)
 *   GET  /dsh-notifier/status               diagnostics for this plugin
 *   POST /dsh-notifier/test                 post a test notification
 *
 * The helper writes the clicked session to `pending.json` and opens `dsh://open`;
 * the Client half reads the route above and calls `uiWorkspace.openSession()`.
 * That split keeps the banner working while the DSH window is closed.
 *
 * @module @local/dsh-notifier
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** How long a clicked session may wait for a page to pick it up. */
const PENDING_TTL_MS = 12 * 60 * 60 * 1000
/** How many reminders the inbox keeps before dropping the oldest. */
const REMINDER_LIMIT = 60
/** A click targets the Desktop surface; a browser tab may answer after this long. */
const DESKTOP_GRACE_MS = 6000
/** A focus report older than this no longer suppresses a banner. */
const PRESENCE_TTL_MS = 8000
/** Turn end reasons that mean "the agent stopped and wants you". */
const DEFAULT_REASONS = ['completed', 'error', 'max-tokens', 'blocked']

const HELPERS = {
  zh: {
    sessionDone: 'DSH · 会话完成',
    sessionError: 'DSH · 会话出错',
    sessionLimit: 'DSH · 已停止',
    sessionBlocked: 'DSH · 已中断',
    fallbackTitle: 'DSH 会话',
    openHint: '点击打开 DSH 并跳转到该会话',
  },
  en: {
    sessionDone: 'DSH · Session finished',
    sessionError: 'DSH · Session failed',
    sessionLimit: 'DSH · Stopped',
    sessionBlocked: 'DSH · Blocked',
    fallbackTitle: 'DSH session',
    openHint: 'Click to open DSH at this session',
  },
}

const HELPER_RELATIVE = '../helper/build/DSHNotifier.app/Contents/MacOS/DSHNotifier'

/**
 * Register the notifier.
 * @param ctx - Cordis context carrying session events and the web server.
 * @param config - Row configuration from `cordis.patch.yml`.
 */
export function apply(ctx, config = {}) {
  const options = normalizeConfig(config)
  const systemLanguage = resolveLanguage(options.locale)
  /** Locale the live page reported; it follows the DSH UI, not the OS. */
  let pageLocale = ''
  /** Client build string the page reported, for diagnostics after updates. */
  let pageBuild = null

  function language() {
    if (options.locale === 'zh' || options.locale === 'en') return options.locale
    return pageLocale === 'zh' || pageLocale === 'en' ? pageLocale : systemLanguage
  }

  function copy() {
    return HELPERS[language()]
  }
  const stateDir = options.stateDir
  const pendingFile = join(stateDir, 'pending.json')
  const helperBinary = resolveHelperBinary(options.helperPath)
  const artFile = resolveArtFile(options.whaleImage)
  const logger = ctx.get?.('logger') ?? console
  const webServer = ctx.get?.('webServer')

  /** Latest report from the page: whether the DSH window has focus. */
  let presence = { focused: false, surface: 'web', at: 0 }
  /** Per-session timestamps so one turn cannot produce a burst of banners. */
  const lastNotifiedAt = new Map()
  /** Remember at most one fallback warning per process. */
  let warnedFallback = false
  /** Diagnostics for GET /dsh-notifier/status. */
  let lastDelivery = null
  let lastOpened = null
  /** `/notify off` silences banners without unloading the plugin. */
  const muteFile = join(stateDir, 'mute.json')
  let muted = readMuted()
  /** In-app reminder inbox the whale reads; newest first. */
  const remindersFile = join(stateDir, 'reminders.json')
  let reminders = readReminders()

  function log(level, message) {
    const sink = logger[level] ?? logger.info ?? console.log
    try {
      sink.call(logger, `dsh-notifier: ${message}`)
    } catch {
      // Logging never fails the plugin.
    }
  }

  function ensureStateDir() {
    try {
      mkdirSync(stateDir, { recursive: true })
      return true
    } catch (error) {
      log('warn', `cannot create state directory ${stateDir}: ${error.message}`)
      return false
    }
  }

  function isMac() {
    return process.platform === 'darwin'
  }

  // MARK: turn detection

  function describe(event) {
    const reason = event?.data?.reason
    const kind = typeof reason?.kind === 'string' ? reason.kind : 'completed'
    const titles = {
      completed: copy().sessionDone,
      error: copy().sessionError,
      'max-tokens': copy().sessionLimit,
      blocked: copy().sessionBlocked,
      aborted: copy().sessionDone,
      interrupted: copy().sessionDone,
    }
    const message = reason?.kind === 'error' ? String(reason.error?.message ?? '') : ''
    return { kind, subtitle: titles[kind] ?? copy().sessionDone, message }
  }

  /** Whether this turn end belongs to the notifier at all (banner and inbox). */
  function isEligible(session, kind) {
    if (!options.enabled) return false
    if (!DEFAULT_REASONS.includes(kind) && !options.extraReasons.includes(kind)) return false
    const header = session?.header ?? {}
    const isChild = header.origin === 'subagent' || Number(header.delegationDepth ?? 0) > 0
    if (isChild && !options.includeSubagents) return false
    return true
  }

  /** Whether this turn end should also raise a macOS banner. */
  function shouldBanner(sessionId) {
    if (muted) return false
    if (!isMac()) return false
    if (options.suppressWhenFocused && presence.focused && Date.now() - presence.at < PRESENCE_TTL_MS) return false
    const previous = lastNotifiedAt.get(sessionId) ?? 0
    if (options.dedupeWindowMs > 0 && Date.now() - previous < options.dedupeWindowMs) return false
    return true
  }

  function sessionTitleOf(session) {
    const titleService = ctx.get?.('sessionTitle')
    try {
      const snapshot = titleService?.get?.(session)
      if (snapshot && typeof snapshot.title === 'string' && snapshot.title.trim()) return snapshot.title.trim()
    } catch {
      // Title projection is best effort; the cwd is still a fine label.
    }
    return ''
  }

  /** Newest live session, used to keep a test reminder clickable. */
  function latestSessionId() {
    try {
      const live = ctx.get?.('sessions')?.list?.() ?? []
      const last = live[live.length - 1]
      return last?.id ? String(last.id) : ''
    } catch {
      return ''
    }
  }

  function onSessionEvent(session, event) {
    try {
      if (event?.type !== 'turn/end') return
      const { kind, subtitle, message } = describe(event)
      if (!isEligible(session, kind)) return
      const sessionId = String(session?.id ?? '')
      const title = sessionTitleOf(session)
      const cwd = typeof session?.header?.cwd === 'string' ? basename(session.header.cwd) : ''
      const label = title || cwd || copy().fallbackTitle
      const body = message
        ? truncate(message, 180)
        : [cwd && cwd !== label ? cwd : '', copy().openHint].filter(Boolean).join(' · ')
      // The inbox always learns about the turn; only the OS banner is gated.
      recordReminder({ sessionId, title: label, where: cwd, subtitle, kind, body })
      if (!shouldBanner(sessionId)) return
      lastNotifiedAt.set(sessionId, Date.now())
      deliver({
        title: label,
        subtitle,
        body,
        sessionId,
        sessionTitle: label,
        group: `dsh-${sessionId}`,
      })
    } catch (error) {
      log('warn', `turn/end handling failed: ${error?.message ?? error}`)
    }
  }

  // MARK: delivery

  function deliver(payload) {
    ensureStateDir()
    const helper = helperBinary
    if (!helper) {
      showWithOsascript(payload, 'helper-missing')
      return
    }
    let child
    try {
      child = spawn(helper, helperArguments(payload), { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      showWithOsascript(payload, `spawn-error: ${error.message}`)
      return
    }
    let stderr = ''
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        // Already gone.
      }
    }, 30000)
    timer.unref?.()
    child.stdout?.resume()
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-2048)
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      showWithOsascript(payload, `helper-error: ${error.message}`)
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      if (code === 0) {
        lastDelivery = { at: Date.now(), channel: 'helper', sessionId: payload.sessionId }
        return
      }
      lastDelivery = { at: Date.now(), channel: 'helper', code, stderr: stderr.trim(), sessionId: payload.sessionId }
      if (code === 3) {
        // Notification permission denied for the helper app.
        warnFallback(
          `macOS 通知权限未授予，改用 osascript 兜底；请在「系统设置 > 通知 > DSH Notifier」中允许通知后重试。`
        )
        showWithOsascript(payload, 'permission-denied')
        return
      }
      log('warn', `helper exited with ${code}: ${stderr.trim()}`)
    })
  }

  function warnFallback(message) {
    if (warnedFallback) return
    warnedFallback = true
    log('warn', message)
  }

  function helperArguments(payload) {
    return [
      '--title', payload.title,
      '--subtitle', payload.subtitle,
      '--body', payload.body,
      '--session', payload.sessionId,
      '--session-title', payload.sessionTitle ?? payload.title,
      '--pending-file', pendingFile,
      '--open-url', options.openUrl,
      '--group', payload.group ?? '',
    ]
  }

  function showWithOsascript(payload, reason) {
    if (!isMac()) return
    const script = [
      `display notification ${appleScriptString(payload.body)}`,
      `with title ${appleScriptString(payload.title)}`,
      `subtitle ${appleScriptString(payload.subtitle)}`,
    ].join(' ')
    try {
      const child = spawn('osascript', ['-e', script], { stdio: 'ignore' })
      child.on('error', () => {})
      child.on('exit', () => {
        lastDelivery = { at: Date.now(), channel: 'osascript', reason }
      })
      child.unref?.()
    } catch (error) {
      log('warn', `osascript fallback failed: ${error.message}`)
    }
  }

  // MARK: hand-off route

  /**
   * Take the queued sessions for one Client surface.
   *
   * A notification click always opens `dsh://open`, so its entry names the
   * Desktop surface. A browser tab on the same host still answers after
   * `DESKTOP_GRACE_MS`, which keeps a browser-only setup working.
   */
  function readPending(surface) {
    if (!existsSync(pendingFile)) return []
    let parsed
    try {
      parsed = JSON.parse(readFileSync(pendingFile, 'utf8'))
    } catch {
      return []
    }
    const items = Array.isArray(parsed?.items) ? parsed.items : []
    if (items.length === 0) return []
    const now = Date.now()
    const live = items.filter((item) => {
      const sessionId = typeof item?.sessionId === 'string' ? item.sessionId : ''
      return sessionId && now - Number(item?.at ?? 0) < PENDING_TTL_MS
    })
    const deliverable = live.filter((item) => {
      if (item?.target !== 'desktop' || surface === 'desktop') return true
      return now - Number(item?.at ?? 0) >= DESKTOP_GRACE_MS
    })
    const remaining = live.filter((item) => !deliverable.includes(item))
    if (remaining.length > 0) writePending(remaining)
    else clearPending()
    return deliverable.map((item) => ({
      sessionId: String(item.sessionId),
      title: typeof item.title === 'string' ? item.title : '',
      at: Number(item.at ?? 0),
    }))
  }

  function writePending(items) {
    try {
      writeFileSync(pendingFile, JSON.stringify({ version: 1, items }), 'utf8')
    } catch (error) {
      log('warn', `cannot update ${pendingFile}: ${error.message}`)
    }
  }

  function clearPending() {
    try {
      writeFileSync(pendingFile, JSON.stringify({ version: 1, items: [] }), 'utf8')
    } catch (error) {
      log('warn', `cannot clear ${pendingFile}: ${error.message}`)
    }
  }

  // MARK: reminder inbox

  function readReminders() {
    try {
      const parsed = JSON.parse(readFileSync(remindersFile, 'utf8'))
      return Array.isArray(parsed?.reminders) ? parsed.reminders : []
    } catch {
      return []
    }
  }

  function persistReminders() {
    try {
      mkdirSync(stateDir, { recursive: true })
      writeFileSync(remindersFile, JSON.stringify({ version: 1, reminders }), 'utf8')
    } catch (error) {
      log('warn', `cannot persist ${remindersFile}: ${error.message}`)
    }
  }

  /** Append one in-app reminder; the whale groups them per session. */
  function recordReminder(input) {
    if (!options.enabled || !input.sessionId) return null
    const entry = {
      id: `rem-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      sessionId: input.sessionId,
      title: input.title ?? '',
      where: input.where ?? '',
      subtitle: input.subtitle ?? '',
      kind: input.kind ?? 'completed',
      body: input.body ?? '',
      at: Date.now(),
      read: false,
    }
    reminders = [entry, ...reminders].slice(0, REMINDER_LIMIT)
    persistReminders()
    return entry
  }

  function markRemindersRead({ sessionId, all }) {
    let changed = false
    reminders = reminders.map((reminder) => {
      const matches = all === true || (sessionId && reminder.sessionId === sessionId)
      if (!matches || reminder.read) return reminder
      changed = true
      return { ...reminder, read: true }
    })
    if (changed) persistReminders()
    return changed
  }

  function unreadCount() {
    return reminders.reduce((count, reminder) => count + (reminder.read ? 0 : 1), 0)
  }

  function pendingCount() {
    if (!existsSync(pendingFile)) return 0
    try {
      const parsed = JSON.parse(readFileSync(pendingFile, 'utf8'))
      return Array.isArray(parsed?.items) ? parsed.items.length : 0
    } catch {
      return 0
    }
  }

  /** Queue one session exactly as a notification click does. */
  function queuePending(sessionId, title = '') {
    if (!sessionId) return false
    if (!ensureStateDir()) return false
    let items = []
    if (existsSync(pendingFile)) {
      try {
        const parsed = JSON.parse(readFileSync(pendingFile, 'utf8'))
        if (Array.isArray(parsed?.items)) items = parsed.items
      } catch {
        items = []
      }
    }
    items = items.filter((item) => String(item?.sessionId ?? '') !== sessionId)
    items.push({ sessionId, title, at: Date.now() })
    if (items.length > 20) items = items.slice(-20)
    try {
      writeFileSync(pendingFile, JSON.stringify({ version: 1, items }), 'utf8')
      return true
    } catch (error) {
      log('warn', `cannot queue ${sessionId}: ${error.message}`)
      return false
    }
  }

  function readBody(req) {
    return new Promise((resolve) => {
      let body = ''
      req.on?.('data', (chunk) => {
        body += chunk
        if (body.length > 16384) req.destroy?.()
      })
      req.on?.('end', () => resolve(body))
      req.on?.('error', () => resolve(body))
    })
  }

  function json(res, status, value) {
    try {
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      })
      res.end(JSON.stringify(value))
    } catch {
      // The page may have gone away.
    }
  }

  async function route(req, res) {
    const url = new URL(req.url ?? '/', 'http://dsh-notifier.local')
    const path = url.pathname
    try {
      if (path === '/dsh-notifier/pending') {
        const surface = url.searchParams.get('surface') === 'desktop' ? 'desktop' : 'web'
        presence = { focused: url.searchParams.get('focused') === '1', surface, at: Date.now() }
        const reported = (url.searchParams.get('locale') ?? '').toLowerCase()
        if (reported.startsWith('zh') || reported.startsWith('en')) pageLocale = reported.slice(0, 2)
        return json(res, 200, { items: readPending(surface), at: Date.now() })
      }
      if (path === '/dsh-notifier/state') {
        const surface = url.searchParams.get('surface') === 'desktop' ? 'desktop' : 'web'
        presence = { focused: url.searchParams.get('focused') === '1', surface, at: Date.now() }
        const reported = (url.searchParams.get('locale') ?? '').toLowerCase()
        if (reported.startsWith('zh') || reported.startsWith('en')) pageLocale = reported.slice(0, 2)
        const build = url.searchParams.get('build')
        if (build) pageBuild = build.slice(0, 24)
        // Read directives ride the poll so one request both marks and re-reads state.
        if (url.searchParams.get('readAll') === '1') {
          markRemindersRead({ all: true })
        } else {
          for (const sessionId of url.searchParams.getAll('read')) {
            if (sessionId) markRemindersRead({ sessionId })
          }
        }
        const live = ctx.get?.('sessions')
        const visible = reminders.slice(0, 40).map((reminder) => {
          if (typeof reminder.where === 'string' && reminder.where) return reminder
          const session = live?.get?.(reminder.sessionId)
          const cwd = typeof session?.header?.cwd === 'string' ? basename(session.header.cwd) : ''
          return cwd ? { ...reminder, where: cwd } : reminder
        })
        return json(res, 200, {
          pending: readPending(surface),
          reminders: visible,
          unread: unreadCount(),
          muted,
          dollSize: options.whaleSize,
          at: Date.now(),
        })
      }
      if (path === '/dsh-notifier/read' && (req.method === 'POST' || req.method === 'GET')) {
        let request = {}
        if (req.method === 'POST') {
          try {
            request = JSON.parse((await readBody(req)) || '{}') ?? {}
          } catch {
            request = {}
          }
        }
        const bySession =
          (typeof request.sessionId === 'string' && request.sessionId) || url.searchParams.get('session') || ''
        const all = request.all === true || url.searchParams.get('all') === '1'
        const changed = markRemindersRead({ sessionId: bySession, all })
        return json(res, 200, { ok: true, changed, unread: unreadCount() })
      }
      if (path === '/dsh-notifier/forget' && req.method === 'POST') {
        let request = {}
        try {
          request = JSON.parse((await readBody(req)) || '{}') ?? {}
        } catch {
          request = {}
        }
        const all = request.all === true || url.searchParams.get('all') === '1'
        const sessionId = typeof request.sessionId === 'string' ? request.sessionId : ''
        const before = reminders.length
        reminders = all ? [] : reminders.filter((reminder) => reminder.sessionId !== sessionId)
        if (reminders.length !== before) persistReminders()
        return json(res, 200, { ok: true, removed: before - reminders.length, unread: unreadCount() })
      }
      if (path === '/dsh-notifier/reminders') {
        return json(res, 200, { reminders: reminders.slice(0, 40), unread: unreadCount() })
      }
      if (path === '/dsh-notifier/opened') {
        lastOpened = {
          sessionId: url.searchParams.get('session') ?? '',
          source: url.searchParams.get('source') ?? 'unknown',
          title: url.searchParams.get('title') ?? '',
          at: Date.now(),
        }
        return json(res, 200, { ok: true })
      }
      if (path === '/dsh-notifier/navigate' && req.method === 'POST') {
        let sessionId = url.searchParams.get('session') ?? ''
        if (!sessionId) {
          try {
            const parsed = JSON.parse((await readBody(req)) || '{}')
            sessionId = typeof parsed?.sessionId === 'string' ? parsed.sessionId : ''
          } catch {
            sessionId = ''
          }
        }
        const queued = queuePending(sessionId, url.searchParams.get('title') ?? '')
        return json(res, queued ? 200 : 400, { ok: queued, sessionId })
      }
      if (path === '/dsh-notifier/art') {
        if (artFile === undefined) return json(res, 404, { error: 'no character image' })
        try {
          const bytes = readFileSync(artFile)
          res.writeHead(200, {
            'content-type': artMime(artFile),
            'content-length': bytes.length,
            'cache-control': 'no-store',
          })
          res.end(bytes)
        } catch (error) {
          json(res, 500, { error: String(error?.message ?? error) })
        }
        return
      }
      if (path === '/dsh-notifier/status') {
        return json(res, 200, {
          enabled: options.enabled,
          platform: process.platform,
          locale: language(),
          pageLocale: pageLocale || null,
          pageBuild,
          helper: { path: helperBinary, exists: helperBinary !== undefined },
          art: { mode: options.whaleImage, file: artFile ?? null },
          stateDir,
          pendingFile,
          pending: pendingCount(),
          reminders: reminders.length,
          unread: unreadCount(),
          muted,
          command: commands?.register ? '/notify' : null,
          presence: { focused: presence.focused, surface: presence.surface, ageMs: Date.now() - presence.at },
          openUrl: options.openUrl,
          config: {
            suppressWhenFocused: options.suppressWhenFocused,
            dedupeWindowMs: options.dedupeWindowMs,
            includeSubagents: options.includeSubagents,
            whaleSize: options.whaleSize,
            whaleImage: options.whaleImage,
            reasons: [...DEFAULT_REASONS, ...options.extraReasons],
          },
          lastDelivery,
          lastOpened,
        })
      }
      if (path === '/dsh-notifier/test' && req.method === 'POST') {
        let request = {}
        try {
          request = JSON.parse((await readBody(req)) || '{}') ?? {}
        } catch {
          request = {}
        }
        const sessionId = typeof request.sessionId === 'string' ? request.sessionId : ''
        const payload = {
          title:
            typeof request.title === 'string' && request.title
              ? request.title
              : language() === 'zh'
                ? 'DSH 测试通知'
                : 'DSH test notification',
          subtitle: copy().sessionDone,
          body: typeof request.body === 'string' && request.body ? request.body : copy().openHint,
          sessionId,
          sessionTitle: typeof request.sessionTitle === 'string' ? request.sessionTitle : '',
          group: 'dsh-test',
        }
        // Exercise both surfaces: the banner and the whale's inbox entry.
        // The inbox entry uses the session's real title so a test row reads
        // like a real one instead of repeating the banner copy.
        const inboxSession = sessionId || latestSessionId()
        if (inboxSession) {
          const liveSession = ctx.get?.('sessions')?.get?.(inboxSession)
          const realTitle = liveSession ? sessionTitleOf(liveSession) : ''
          const cwd = typeof liveSession?.header?.cwd === 'string' ? basename(liveSession.header.cwd) : ''
          recordReminder({
            sessionId: inboxSession,
            title: realTitle || payload.title,
            where: cwd,
            subtitle: payload.subtitle,
            kind: 'completed',
            body: payload.body,
          })
        }
        deliver(payload)
        return json(res, 200, { ok: true, sessionId, helper: helperBinary ?? null, pendingFile })
      }
      return json(res, 404, { error: 'not found' })
    } catch (error) {
      log('warn', `route failed: ${error?.message ?? error}`)
      return json(res, 500, { error: String(error?.message ?? error) })
    }
  }

  // MARK: mute toggle

  function readMuted() {
    try {
      const parsed = JSON.parse(readFileSync(join(stateDir, 'mute.json'), 'utf8'))
      return parsed?.muted === true
    } catch {
      return false
    }
  }

  function writeMuted(next) {
    muted = next
    try {
      mkdirSync(stateDir, { recursive: true })
      writeFileSync(muteFile, JSON.stringify({ muted: next }), 'utf8')
    } catch (error) {
      log('warn', `cannot persist ${muteFile}: ${error.message}`)
    }
  }

  function commandCopy() {
    const zh = language() === 'zh'
    return {
      on: zh ? '会话通知已开启：会话完成时会弹 macOS 横幅。' : 'Session notifications are on: macOS banners return.',
      off: zh ? '会话通知已静音：不再弹横幅，插件与跳转仍然保留。恢复：/notify on' : 'Session notifications are muted. Banners stop; the plugin and jump stay. Resume with /notify on.',
      statusOn: zh ? '会话通知：开启中。关闭：/notify off' : 'Session notifications: on. Mute with /notify off',
      statusOff: zh ? '会话通知：已静音。恢复：/notify on' : 'Session notifications: muted. Resume with /notify on',
      test: zh ? '已发出测试横幅，点击可回到本会话。' : 'Test banner sent; click it to come back to this session.',
      usage: zh
        ? '用法：/notify [on|off|status|test]'
        : 'Usage: /notify [on|off|status|test]',
      unknown: zh ? '未知参数。' : 'Unknown argument.',
    }
  }

  function runNotifyCommand(invocation) {
    const argument = String(invocation?.rawInput ?? '').trim().toLowerCase()
    const text = commandCopy()
    if (argument === '' || argument === 'status') {
      return { kind: 'success', text: muted ? text.statusOff : text.statusOn }
    }
    if (argument === 'off' || argument === 'mute') {
      writeMuted(true)
      return { kind: 'success', text: text.off }
    }
    if (argument === 'on' || argument === 'unmute') {
      writeMuted(false)
      return { kind: 'success', text: text.on }
    }
    if (argument === 'test') {
      const sessionId = String(invocation?.agent?.id ?? '')
      const live = ctx.get?.('sessions')?.get?.(sessionId)
      const label = live ? sessionTitleOf(live) : ''
      recordReminder({ sessionId, title: label || copy().fallbackTitle, subtitle: copy().sessionDone, kind: 'completed', body: copy().openHint })
      deliver({
        title: label || (language() === 'zh' ? 'DSH 测试通知' : 'DSH test notification'),
        subtitle: copy().sessionDone,
        body: copy().openHint,
        sessionId,
        sessionTitle: label,
        group: 'dsh-test',
      })
      return { kind: 'success', text: text.test }
    }
    return { kind: 'error', text: `${text.unknown} ${text.usage}` }
  }

  // MARK: activation

  ctx.effect(() => ctx.on('session/event', onSessionEvent), 'dsh-notifier: turn/end listener')

  const commands = ctx.get?.('commands')
  if (commands?.register) {
    ctx.effect(
      () =>
        commands.register({
          definitionId: '@local/dsh-notifier',
          name: 'notify',
          description: 'Turn DSH session banners on or off',
          input: { hint: '[on|off|status|test]' },
          handler: runNotifyCommand,
        }),
      'dsh-notifier: /notify command',
    )
  }

  if (webServer?.register) {
    ctx.effect(
      () => webServer.register({ kind: 'prefix', path: '/dsh-notifier', handler: route }),
      'dsh-notifier: hand-off route',
    )
  } else {
    log('warn', 'webServer service is unavailable; the click hand-off cannot reach the page')
  }

  if (options.enabled && isMac() && helperBinary && options.requestPermission !== false) {
    // Ask once, and only while macOS still reports `notDetermined`.
    ctx.effect(() => {
      try {
        const child = spawn(helperBinary, ['--ensure-permission'], { stdio: 'ignore' })
        child.on('error', () => {})
        child.unref?.()
      } catch {
        // Permission stays undetermined; the first banner asks again.
      }
    }, 'dsh-notifier: notification permission')
  }

  if (!isMac()) log('info', `notifications are macOS-only; this host is ${process.platform}`)
  else if (!helperBinary) {
    log(
      'warn',
      `notification helper not found; run helper/build.sh to build it (expected at ${join(stateDir, HELPER_RELATIVE)})`,
    )
  }
}

// MARK: helpers

function normalizeConfig(config) {
  const raw = config && typeof config === 'object' ? config : {}
  const extraReasons = []
  if (raw.notifyOnAborted === true) extraReasons.push('aborted')
  if (raw.notifyOnInterrupted === true) extraReasons.push('interrupted')
  return {
    enabled: raw.enabled !== false,
    locale: typeof raw.locale === 'string' ? raw.locale : 'auto',
    suppressWhenFocused: raw.suppressWhenFocused === true,
    dedupeWindowMs: Number.isFinite(raw.dedupeWindowMs) ? Math.max(0, raw.dedupeWindowMs) : 1500,
    includeSubagents: raw.includeSubagents === true,
    requestPermission: raw.requestPermission !== false,
    helperPath: typeof raw.helperPath === 'string' ? raw.helperPath : '',
    whaleImage: typeof raw.whaleImage === 'string' && raw.whaleImage ? raw.whaleImage : 'auto',
    whaleSize: Number.isFinite(raw.whaleSize) ? Math.min(220, Math.max(48, Math.round(raw.whaleSize))) : 96,
    stateDir:
      typeof raw.stateDir === 'string' && raw.stateDir
        ? raw.stateDir
        : join(homedir(), 'Library', 'Application Support', 'dsh-notifier'),
    openUrl: typeof raw.openUrl === 'string' && raw.openUrl ? raw.openUrl : 'dsh://open',
    extraReasons,
  }
}

function resolveLanguage(preference) {
  if (preference === 'zh' || preference === 'en') return preference
  try {
    const locale = new Intl.DateTimeFormat().resolvedOptions().locale ?? ''
    return locale.toLowerCase().startsWith('zh') ? 'zh' : 'en'
  } catch {
    return 'en'
  }
}

function resolveHelperBinary(configured) {
  if (!isMacPlatform()) return undefined
  const candidates = []
  if (configured) candidates.push(configured)
  if (process.env.DSH_NOTIFIER_HELPER) candidates.push(process.env.DSH_NOTIFIER_HELPER)
  candidates.push(fileURLToPath(new URL(HELPER_RELATIVE, import.meta.url)))
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) return candidate
    } catch {
      // Try the next candidate.
    }
  }
  return undefined
}

/** Expand a leading `~` in a configured path. */
function expandHome(value) {
  return value.startsWith('~/') ? join(homedir(), value.slice(2)) : value
}

/**
 * Resolve the character image for the whale doll.
 *
 * `auto` looks for the artwork of an installed companion plugin and serves it
 * from its own location: nothing is copied into this package, so the plugin
 * keeps working (with its built-in SVG whale) when that file is absent.
 */
function resolveArtFile(option) {
  if (option === 'builtin' || option === 'none') return undefined
  const candidates = []
  if (option !== 'auto') candidates.push(expandHome(option))
  if (process.env.DSH_NOTIFIER_WHALE_IMAGE) candidates.push(expandHome(process.env.DSH_NOTIFIER_WHALE_IMAGE))
  const profileDirs = [process.env.DSH_PROFILE_DIR, join(homedir(), '.dsh', 'profiles', 'desktop')].filter(
    (value) => typeof value === 'string' && value.length > 0,
  )
  for (const dir of profileDirs) {
    for (const name of ['DSniang1.png', 'DSniang02.png']) {
      candidates.push(join(dir, 'node_modules', 'dsh-whale-widget', 'assets', name))
    }
  }
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) return candidate
    } catch {
      // Try the next candidate.
    }
  }
  return undefined
}

function artMime(file) {
  const lower = String(file).toLowerCase()
  if (lower.endsWith('.png')) return 'image/png'
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
  if (lower.endsWith('.webp')) return 'image/webp'
  if (lower.endsWith('.gif')) return 'image/gif'
  return 'application/octet-stream'
}

function isMacPlatform() {
  return process.platform === 'darwin'
}

function truncate(text, limit) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim()
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value
}

function appleScriptString(text) {
  return `"${String(text ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}
