# Attribution

## Character artwork (not included in this repository)

The whale doll can display character artwork that belongs to
[**dsh-whale-widget** — DeepSeek 余额小鲸鱼挂件](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget)
by MeteorNOX (`assets/DSniang1.png` / `DSniang02.png`).

That project licenses its **code** under MIT, but its `PROVENANCE.md` states
that the **artwork** (`assets/**`, `icon.png`) is provided **as-is**, is not
covered by MIT, and is not sublicensed. This repository therefore does **not**
include, copy, or redistribute those images.

What happens instead:

- With the default `whaleImage: auto`, the Host half looks for an **already
  installed** copy of that plugin on the same machine
  (`~/.dsh/profiles/*/node_modules/dsh-whale-widget/assets/DSniang1.png`) and
  serves it to the page through `GET /dsh-notifier/art`. Nothing is bundled.
- If the file is absent, the plugin falls back to its own SVG whale.
- `whaleImage: builtin` disables the lookup entirely; `whaleImage: <path>`
  points at artwork you supply and are allowed to use.

If you are the rights holder and want this lookup removed, open an issue and
it will be dropped in the next release.

## Design references

The comic speech bubble (white fill, deep-navy outline, two tail puffs, and
the staggered pop-in animation) is modelled on the bubble style of the same
plugin, whose code is MIT licensed. The geometry and colours here are drawn
for this project rather than copied byte-for-byte.

## Original artwork in this repository

These files were drawn for DSH Notifier and are covered by this project's MIT
license:

| File | What it is |
| --- | --- |
| `icon.svg` | Plugin icon: a bell with a notification dot |
| `helper/AppIcon.icns` | macOS app icon, rendered from `icon.svg` by `helper/make-icon.sh` |
| `docs/preview.svg` | Feature illustration for the plugin details page |
| `src/client.js` (`whaleSvg`) | Built-in SVG whale used when no character image is available |

## Prior art and APIs

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin,
  slot, event, and command APIs.
- Apple's `UserNotifications` framework for the notification helper.
