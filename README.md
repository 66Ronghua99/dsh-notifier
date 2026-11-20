# DSH Notifier

A macOS banner when a DeepSeek Harness session finishes a turn. Click it and DSH comes forward at that exact session — even if the window was closed when the turn ended.

> **Repo:** [github.com/66Ronghua99/dsh-notifier](https://github.com/66Ronghua99/dsh-notifier) · **License:** MIT (code) · third-party character art is **not** bundled — see [ATTRIBUTION.md](ATTRIBUTION.md).

```
turn/end → host half → helper app (banner)
                               │ click
                               ▼
                    pending.json + open dsh://open
                               │
                               ▼
                 client half → uiWorkspace.openSession(sessionId)
```

## What it does

- Watches durable `turn/end` session events, so a banner means the agent really stopped and owes you an answer (not just a lull between tool calls).
- Skips subagent turns, forked turns, and turns you ended yourself.
- Notifies even while the DSH window is in front (set `suppressWhenFocused: true` to go back to background-only banners).
- Classifies the ending: `会话完成`, `会话出错` (with the error text), `已停止` (max tokens), `已中断`.
- Adds a whale doll in `shell.overlay`: it pops a speech bubble when a session finishes (clicking the bubble switches to that session), and clicking the doll opens a per-session reminder inbox. The panel footer resizes the doll (48–220 px) and remembers the choice; `whaleSize` sets the starting size. Rows are unread only: jumping to one clears it from the list, so the panel empties as you work through it. Drag the doll to move it; the position is remembered. `全部已读` clears the rest, and `/notify off` mutes the OS banners only — the doll keeps collecting.
- Writes the clicked session to `~/Library/Application Support/dsh-notifier/pending.json` and opens `dsh://open`, so the click works with DSH open, hidden, or quit-and-relaunch.
- Falls back to `osascript` notifications if the helper app is missing or notification permission was denied (the fallback banner is not clickable).

## Install

```sh
# 0. Clone (or download) this repository to a directory you keep
git clone https://github.com/66Ronghua99/dsh-notifier.git
cd dsh-notifier

# 1. Build the native helper (once; needs Xcode Command Line Tools)
./helper/build.sh

# 2. Add this directory as a bundle in the DSH profile
#    Settings → Plugins → Add plugin → this directory (or `dsh plugin add <dir>`)
```

The first activation asks macOS for notification permission for **DSH Notifier**. If the banner never appears, allow it in **System Settings → Notifications → DSH Notifier** and run `POST /dsh-notifier/test` (below).

Rebuilding the helper changes its code signature, which macOS treats as a new app: allow notifications again after `./helper/build.sh`.

## Turning it off

| Scope | How |
| --- | --- |
| Everything (banners, `/notify`, the click hand-off) | **Settings → Plugins → DSH Notifier** and switch the row off; switch it back on to resume. |
| Banners only, without unloading the plugin | Type `/notify off` in any conversation; `/notify on` resumes. The state is stored in `<stateDir>/mute.json` and survives a restart. |
| Permanently, from configuration | Set `enabled: false` on the `dsh-notifier` row in the profile's `cordis.patch.yml`. |

`/notify status` reports the current state, and `/notify test` posts a banner for the conversation you are in, so you can check the click without waiting for a turn.

## Configuration

Set these in the profile's `cordis.patch.yml` under the `dsh-notifier` row:

```yaml
- id: dsh-notifier
  config:
    enabled: true
    locale: auto              # auto | zh | en
    suppressWhenFocused: true # no banner while the DSH window is focused
    dedupeWindowMs: 1500      # minimum gap between two banners for one session
    includeSubagents: false   # also notify for subagent sessions
    notifyOnAborted: false    # also notify when you abort a turn
    notifyOnInterrupted: false
    requestPermission: true   # ask macOS once at activation
    openUrl: dsh://open       # URL opened by the click
    whaleImage: auto          # auto | builtin | absolute path to a PNG/GIF of your own
    whaleSize: 96             # doll size in px (48–220); adjustable in the panel too
    stateDir: ~/Library/Application Support/dsh-notifier
    helperPath: ''            # override the bundled helper binary
```

## Character art

The doll prefers a real character image and falls back to the built-in SVG whale.
With `whaleImage: auto` the Host looks for the artwork of an installed
`dsh-whale-widget` (`assets/DSniang1.png`) and serves it from **its own location**
through `GET /dsh-notifier/art` — nothing is copied into this package, and the
plugin keeps working when that file is gone. Set `whaleImage: builtin` for the
SVG whale only, or point it at your own PNG/GIF.

That artwork is not covered by the widget's MIT code license (see its
`PROVENANCE.md`: provided as-is, no sublicense), so this plugin never bundles it;
it only reads the copy already installed on this machine. Before publishing the
bundle, keep it in `auto`/`builtin` mode.

## HTTP endpoints

Served by the DSH web server, same origin as the GUI:

| Endpoint | Purpose |
| --- | --- |
| `GET /dsh-notifier/state?focused=0\|1&surface=desktop\|web` | Everything the client half needs: queued clicked sessions, the reminder inbox, unread count, mute state. |
| `GET /dsh-notifier/pending?…` | Same hand-off queue on its own (kept for scripts and older clients). |
| `POST /dsh-notifier/read` | Mark one session read (`{"sessionId":"…"}`) or all (`{"all":true}`); `GET /dsh-notifier/read?session=…` / `?all=1` works too. The client half instead rides these directives on the poll (`/state?read=…` / `?readAll=1`) so marking read never needs a separate write. |
| `POST /dsh-notifier/forget` | Drop one session's reminders (`{"sessionId":"…"}`) or all (`{"all":true}`). |
| `GET /dsh-notifier/reminders` | Read the inbox without consuming hand-offs. |
| `GET /dsh-notifier/status` | Helper path, permission diagnostics, pending count, last delivery and last navigation. |
| `POST /dsh-notifier/test` | Post a test banner, optionally for one session: `{"sessionId":"…","title":"…","body":"…"}`. |
| `POST /dsh-notifier/navigate` | Queue one session as a notification click would: `{"sessionId":"…"}`. |
| `GET /dsh-notifier/opened?session=…` | The client half reports a completed navigation (diagnostics only). |

```sh
# Test banner that will jump to a session when clicked
curl -s -X POST http://127.0.0.1:58208/dsh-notifier/test \
  -H 'content-type: application/json' \
  -d '{"sessionId":"session-…","title":"DSH 通知测试"}'

# Test the click hand-off without a click
curl -s -X POST http://127.0.0.1:58208/dsh-notifier/navigate \
  -H 'content-type: application/json' -d '{"sessionId":"session-…"}'

curl -s http://127.0.0.1:58208/dsh-notifier/status
```

A click always opens `dsh://open`, so its queue entry targets the Desktop surface; a browser tab on the same host answers only after a 6-second grace period, which keeps a browser-only setup working.

## Verify on this machine

```sh
node scripts/selftest.mjs   # synthetic turn/end -> real banner, routes, hand-off
```

Then: switch away from DSH, let a turn finish, and click the banner. The DSH window comes forward and the session opens. `GET /dsh-notifier/status` shows `lastDelivery` (banner), `presence` (surface/focus), and `lastOpened` (navigation) after a click.

## Credits

- Character artwork: **dsh-whale-widget** by [MeteorNOX](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget).
  Its code is MIT, but its artwork is provided as-is and is **not** redistributed here:
  with `whaleImage: auto` the plugin reads the copy already installed on your machine
  and serves it at runtime. The project's own SVG whale is used when that copy is absent.
- The comic speech-bubble treatment is inspired by the same plugin's bubble (MIT code).
- Our plugin icon (bell), app icon, detail illustration, and built-in whale are original to this project.

Details: [ATTRIBUTION.md](ATTRIBUTION.md).

## Limitations

- macOS only (v1). Other platforms keep the plugin inert.
- The Dock badge is not implemented: the DSH Host runs as a plain Node child of the Desktop shell, so it cannot touch the Dock icon. The banner, plus the `dsh://open` focus on click, is the v1 notification surface.
- A turn that stops on an approval or question prompt does not end, so it produces no banner.
- Clicking a banner focuses the primary DSH Desktop window. If you drive DSH in a separate browser tab, that tab also picks the pending session up on its next poll.
- The helper is ad-hoc signed. macOS may ask for notification permission again after a rebuild or after the package moves.
