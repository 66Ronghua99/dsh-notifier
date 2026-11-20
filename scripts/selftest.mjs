// Development self-check for the DSH Notifier host half.
//
// Runs the plugin against a stub Cordis context, drives one synthetic `turn/end`
// through the real helper app, then exercises the hand-off route with a request
// and response stub. It never touches a live DSH profile.
//
//   node scripts/selftest.mjs
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { apply } from '../src/host.js'

const here = dirname(fileURLToPath(import.meta.url))
const stateDir = join(here, '..', '.build', 'selftest-state')
const pendingFile = join(stateDir, 'pending.json')
const helperPath = join(
  here, '..', 'helper', 'build', 'DSHNotifier.app', 'Contents', 'MacOS', 'DSHNotifier',
)

rmSync(stateDir, { recursive: true, force: true })
mkdirSync(stateDir, { recursive: true })

const listeners = new Map()
const routes = []
const logs = []
const commands = []

const stubLogger = {
  info: (message) => logs.push(['info', message]),
  warn: (message) => logs.push(['warn', message]),
}

const ctx = {
  effect(callback) {
    const dispose = callback()
    return typeof dispose === 'function' ? dispose : () => {}
  },
  on(name, listener) {
    if (!listeners.has(name)) listeners.set(name, [])
    listeners.get(name).push(listener)
    return () => {}
  },
  get(name) {
    if (name === 'sessionTitle') return { get: () => ({ title: '重构通知插件' }) }
    if (name === 'logger') return stubLogger
    if (name === 'webServer') return ctx.webServer
    if (name === 'commands') {
      return {
        register(definition) {
          commands.push(definition)
          return () => {}
        },
      }
    }
    return undefined
  },
  webServer: {
    register(route) {
      routes.push(route)
      return () => {}
    },
  },
}

apply(ctx, {
  enabled: true,
  locale: 'zh',
  suppressWhenFocused: false,
  dedupeWindowMs: 0,
  stateDir,
  helperPath,
})

const failures = []
const check = (name, condition, detail = '') => {
  if (condition) console.log(`  ok   ${name}`)
  else {
    console.log(`  FAIL ${name} ${detail}`)
    failures.push(name)
  }
}

const route = routes.find((candidate) => candidate.path === '/dsh-notifier')
check('route registered', route !== undefined)

function request(path, method = 'GET', body = undefined) {
  const url = new URL(path, 'http://127.0.0.1:1')
  const response = {
    statusCode: 0,
    headers: {},
    writeHead(status, headers) {
      this.statusCode = status
      this.headers = headers ?? {}
    },
    end(body) {
      this.body = body
    },
  }
  const req = {
    url: url.pathname + url.search,
    method,
    on(name, listener) {
      if (name === 'data' && body !== undefined) listener(Buffer.from(body))
      if (name === 'end') listener()
    },
  }
  const result = route.handler(req, response)
  return result instanceof Promise ? result.then(() => settle(response)) : settle(response)
}

function settle(response) {
  const text = response.body ?? 'null'
  return { status: response.statusCode, json: JSON.parse(text) }
}

// 1. Turn detection reaches the helper (a real banner is posted).
const session = {
  id: 'session-selftest',
  header: { cwd: '/Users/cory/codes/DSH-notifier' },
}
for (const listener of listeners.get('session/event') ?? []) {
  listener(session, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
}
await new Promise((resolve) => setTimeout(resolve, 2500))
const statusAfterTurn = await request('/dsh-notifier/status')
check('turn/end produced a delivery', statusAfterTurn.json.lastDelivery !== null, JSON.stringify(statusAfterTurn.json))
check(
  'delivery used the helper',
  statusAfterTurn.json.lastDelivery?.channel === 'helper',
  JSON.stringify(statusAfterTurn.json.lastDelivery),
)

// 2. Subagent turns stay silent.
writeFileSync(pendingFile, JSON.stringify({ version: 1, items: [] }))
for (const listener of listeners.get('session/event') ?? []) {
  listener(
    { id: 'session-sub', header: { cwd: '/tmp', origin: 'subagent' } },
    { type: 'turn/end', data: { reason: { kind: 'completed' } } },
  )
}
await new Promise((resolve) => setTimeout(resolve, 300))

// 3. The hand-off route reads and clears what a click would queue.
writeFileSync(
  pendingFile,
  JSON.stringify({
    version: 1,
    items: [
      { sessionId: 'session-clicked', title: '被点击的会话', at: Date.now() },
      { sessionId: 'session-expired', title: 'too old', at: Date.now() - 40 * 60 * 60 * 1000 },
    ],
  }),
)
const first = await request('/dsh-notifier/pending?focused=0')
check('pending returns the fresh item only', first.json.items.length === 1 && first.json.items[0].sessionId === 'session-clicked', JSON.stringify(first.json))
check('pending route answers 200', first.status === 200)
const second = await request('/dsh-notifier/pending?focused=0')
check('pending is consumed once', second.json.items.length === 0, JSON.stringify(second.json))
check('pending file was cleared', JSON.parse(readFileSync(pendingFile, 'utf8')).items.length === 0)

// 4. Focus reporting reaches the status endpoint.
await request('/dsh-notifier/pending?focused=1')
const statusFocused = await request('/dsh-notifier/status')
check('focus report is tracked', statusFocused.json.presence.focused === true)

// 5. `navigate` queues a session, and `opened` records the page's navigation.
const navigate = await request('/dsh-notifier/navigate', 'POST', JSON.stringify({ sessionId: 'session-navigate' }))
check('navigate queues the session', navigate.status === 200 && navigate.json.ok === true, JSON.stringify(navigate.json))
const queued = await request('/dsh-notifier/pending?focused=0')
check('queued session is delivered to the page', queued.json.items[0]?.sessionId === 'session-navigate', JSON.stringify(queued.json))
await request('/dsh-notifier/opened?session=session-navigate')
const statusOpened = await request('/dsh-notifier/status')
check('navigation is recorded for diagnostics', statusOpened.json.lastOpened?.sessionId === 'session-navigate', JSON.stringify(statusOpened.json.lastOpened))

// 6. A click entry is held for the Desktop surface, then released to a browser tab.
writeFileSync(
  pendingFile,
  JSON.stringify({
    version: 1,
    items: [{ sessionId: 'session-desktop', title: 'desktop', at: Date.now(), target: 'desktop' }],
  }),
)
const webPeek = await request('/dsh-notifier/pending?focused=0&surface=web')
check('desktop click is not taken by a browser tab', webPeek.json.items.length === 0, JSON.stringify(webPeek.json))
check('held entry survives the browser poll', JSON.parse(readFileSync(pendingFile, 'utf8')).items.length === 1)
const desktopTake = await request('/dsh-notifier/pending?focused=0&surface=desktop')
check('desktop surface takes its click', desktopTake.json.items[0]?.sessionId === 'session-desktop', JSON.stringify(desktopTake.json))
const statusSurface = await request('/dsh-notifier/status')
check('surface is tracked for diagnostics', statusSurface.json.presence.surface === 'desktop', JSON.stringify(statusSurface.json.presence))

// 7. `/notify` mutes banners without unloading the plugin.
const notify = commands.find((candidate) => candidate.name === 'notify')
check('/notify command registered', notify !== undefined)
const turnEnd = () => {
  for (const listener of listeners.get('session/event') ?? []) {
    listener(session, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  }
}
const before = (await request('/dsh-notifier/status')).json.lastDelivery?.at ?? 0
const offResult = notify.handler({ rawInput: 'off', agent: { id: 'session-selftest' } })
check('/notify off answers success', offResult.kind === 'success', JSON.stringify(offResult))
check('/notify off reports muted', (await request('/dsh-notifier/status')).json.muted === true)
turnEnd()
await new Promise((resolve) => setTimeout(resolve, 400))
check('muted turn/end posts no banner', ((await request('/dsh-notifier/status')).json.lastDelivery?.at ?? 0) === before)
const mutedState = await request('/dsh-notifier/state?focused=0&surface=desktop')
check('muted turn/end still fills the whale inbox', mutedState.json.reminders.some((reminder) => reminder.sessionId === 'session-selftest') && mutedState.json.muted === true, JSON.stringify({ unread: mutedState.json.unread, muted: mutedState.json.muted }))
const onResult = notify.handler({ rawInput: 'on', agent: { id: 'session-selftest' } })
check('/notify on answers success', onResult.kind === 'success', JSON.stringify(onResult))
turnEnd()
await new Promise((resolve) => setTimeout(resolve, 2500))
check('unmuted turn/end posts again', ((await request('/dsh-notifier/status')).json.lastDelivery?.at ?? 0) > before)
const testResult = notify.handler({ rawInput: 'test', agent: { id: 'session-command-test' } })
await new Promise((resolve) => setTimeout(resolve, 2500))
const afterTest = (await request('/dsh-notifier/status')).json
check('/notify test posts for the calling session', testResult.kind === 'success' && afterTest.lastDelivery?.sessionId === 'session-command-test', JSON.stringify(afterTest.lastDelivery))
check('/notify status reports state', String(notify.handler({ rawInput: 'status', agent: {} }).text).includes('开启') || String(notify.handler({ rawInput: 'status', agent: {} }).text).includes('on'))

// 8. The reminder inbox is per session and `/read` clears it.
const sessionReminders = (await request('/dsh-notifier/state?focused=0&surface=desktop')).json.reminders.filter(
  (reminder) => reminder.sessionId === 'session-selftest',
)
check('/state groups reminders by session', sessionReminders.length >= 2, String(sessionReminders.length))
check('/state reports unread reminders', sessionReminders.some((reminder) => reminder.read === false))
await request('/dsh-notifier/read', 'POST', JSON.stringify({ sessionId: 'session-selftest' }))
const afterRead = (await request('/dsh-notifier/state?focused=0&surface=desktop')).json.reminders.filter(
  (reminder) => reminder.sessionId === 'session-selftest',
)
check('/read marks that session read', afterRead.every((reminder) => reminder.read === true), JSON.stringify(afterRead.map((r) => r.read)))

// 9. Read directives ride the state poll, and `/read` accepts GET too.
writeFileSync(
  pendingFile,
  JSON.stringify({ version: 1, items: [] }),
)
const seed = await request('/dsh-notifier/test', 'POST', JSON.stringify({ sessionId: 'session-poll-read' }))
check('/test seeds a reminder', seed.status === 200)
const beforePollRead = (await request('/dsh-notifier/state?focused=0&surface=desktop')).json
const seeded = beforePollRead.reminders.find((reminder) => reminder.sessionId === 'session-poll-read')
check('seed reminder is unread', seeded?.read === false, JSON.stringify(seeded))
const pollRead = await request('/dsh-notifier/state?focused=0&surface=desktop&read=session-poll-read')
const afterPollRead = pollRead.json.reminders.find((reminder) => reminder.sessionId === 'session-poll-read')
check('read directive on the poll marks it read', afterPollRead?.read === true, JSON.stringify(afterPollRead))
const allRead = await request('/dsh-notifier/read?all=1')
check('/read accepts GET with ?all=1', allRead.status === 200 && allRead.json.unread === 0, JSON.stringify(allRead.json))

// 10. Unknown routes answer 404.
check('unknown route answers 404', (await request('/dsh-notifier/nope')).status === 404)

console.log('\nlogs:')
for (const [level, message] of logs) console.log(`  ${level}: ${message}`)

if (!existsSync(helperPath)) {
  console.log('\nwarning: helper binary missing; run helper/build.sh')
}

if (failures.length > 0) {
  console.log(`\n${failures.length} check(s) failed`)
  process.exit(1)
}
console.log('\nall checks passed')
