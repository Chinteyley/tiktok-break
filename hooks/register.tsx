import type { EngineInterface, Register, Timer } from 'claude-code'

const FEED = 'https://www.tiktok.com/foryou'
const LOGIN = 'https://www.tiktok.com/login'
// A turn shorter than this is not worth the context switch, so the window waits.
const DELAY_MS = 10_000
const PANE = 'tiktok'
// From this width the fullscreen layout docks a pane beside the transcript.
const DOCK_COLUMNS = 110
// An Image's box is at most this many cells each way.
const MAX_CELLS = 255
// The pane's controls: the key that presses each while the pane has the
// keyboard, the viewer's name for what it does, and its label.
const CONTROLS = [
  ['k', 'prev', 'Prev'],
  ['j', 'next', 'Next'],
  ['p', 'pause', 'Pause'],
  ['m', 'mute', 'Mute'],
  ['l', 'like', 'Like'],
  ['r', 'repost', 'Repost'],
] as const
const CONTROL_GAP = 2

let isEnabled = true
let isWorking = false
// Set while a break is pending or showing.
let timer: Timer | undefined
// The break window is up, opened by the timer.
let isShowing = false
// The viewer feeding the pane, while it runs.
let viewer: ReturnType<EngineInterface['process']['spawn']> | undefined
let generation = 0

async function profile($: EngineInterface) {
  return `${await $.env.get('HOME')}/Library/Application Support/tiktok-break`
}

async function frame($: EngineInterface) {
  return `${await profile($)}/pane-frame.png`
}

async function socket($: EngineInterface) {
  return `${await profile($)}/pane.sock`
}

// Chrome runs on a profile of its own, so the window is a process this mod
// can end without touching the person's own browser.
async function open($: EngineInterface, url: string) {
  const { exitCode } = await $.process.run([
    'open',
    '-na',
    'Google Chrome',
    '--args',
    `--app=${url}`,
    `--user-data-dir=${await profile($)}`,
    '--window-size=430,900',
    '--no-first-run',
    '--no-default-browser-check',
  ])

  if (exitCode !== 0) {
    $.ui.toast('tiktok-break: could not open Google Chrome')
  }
}

// Whether any Chrome runs on the mod's profile: a window, or the pane's.
async function isBusy($: EngineInterface) {
  const { exitCode } = await $.process.run([
    'pgrep',
    '-f',
    `Google Chrome .*--user-data-dir=${await profile($)}`,
  ])

  return exitCode === 0
}

// Ends a window on the mod's profile; resolves true when one was up.
async function quit($: EngineInterface) {
  const { exitCode } = await $.process.run([
    'pkill',
    '-f',
    `Google Chrome --app=[^ ]* --user-data-dir=${await profile($)}`,
  ])

  return exitCode === 0
}

// What the timer does. A window the person opened to log in is left alone:
// a second one would share its process, and close it when the turn ends.
async function takeBreak($: EngineInterface) {
  if (await isBusy($)) {
    return
  }

  isShowing = true
  await open($, FEED)
}

function arm($: EngineInterface) {
  if (isEnabled && isWorking && viewer === undefined) {
    timer ??= $.clock.after(DELAY_MS, () => void takeBreak($))
  }
}

// Resolves true when the break window was showing.
async function close($: EngineInterface) {
  timer?.cancel()
  timer = undefined

  if (!isShowing) {
    return false
  }

  isShowing = false

  return quit($)
}

// Chrome takes a moment to leave the profile, and one started before then
// is handed to the one leaving and lost.
async function settle($: EngineInterface) {
  for (let i = 0; i < 20 && (await isBusy($)); i++) {
    await $.clock.sleep(150)
  }
}

// Runs the viewer and repaints the pane's picture at each frame it writes;
// the loop is the viewer's life, so ending the stream ends the playback.
// Docked there is room to frame a video with its likes and creator; the
// small block above the prompt frames the video alone.
async function watch($: EngineInterface, isDocked: boolean) {
  const file = await frame($)
  const frames = $.process.spawn({
    argv: [
      'bun',
      `${$.plugin.root}/viewer/viewer.ts`,
      await profile($),
      file,
      await socket($),
      isDocked ? 'item' : 'video',
    ],
  })
  viewer = frames
  let complaint = ''

  try {
    for await (const piece of frames) {
      if (piece.stream === 'stderr') {
        complaint = piece.text
        continue
      }

      generation += 1
      void $.ui.blit({
        requestId: PANE,
        key: 'view',
        source: { file, format: 'png', generation },
      })
    }
  } catch {
    complaint = 'bun could not be started'
  }

  // Still ours: the viewer ended by itself, not by the pane closing.
  if (viewer === frames) {
    viewer = undefined
    $.ui.toast(`tiktok-break: the viewer stopped. ${complaint.slice(0, 120)}`)
  }
}

async function unwatch() {
  const frames = viewer
  viewer = undefined
  await frames?.return({ code: null, signal: 'SIGTERM' })
}

// How many rows the controls take once they wrap at this width; each is
// drawn as its key, a colon, a space and its label.
function controlRows(columns: number) {
  let rows = 1
  let used = 0

  for (const [, , label] of CONTROLS) {
    const width = label.length + 3

    if (used > 0 && used + CONTROL_GAP + width > columns) {
      rows += 1
      used = width
    } else {
      used += (used > 0 ? CONTROL_GAP : 0) + width
    }
  }

  return rows
}

// Hands one of the pane's controls to the viewer, which presses TikTok's own
// key for it.
async function send($: EngineInterface, action: string) {
  try {
    await $.http.fetch('http://viewer/', {
      method: 'POST',
      body: action,
      socketPath: await socket($),
    })
  } catch (error) {
    $.ui.toast(`tiktok-break: ${String(error).slice(0, 120)}`)
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    isEnabled = (await $.store.get('isEnabled')) !== false
    await $.command.register({
      name: 'tiktok',
      description:
        'Turn the TikTok break window on or off; "pane" plays it in a side pane, "login" opens a window to log in',
      argumentHint: '[pane|login]',
      immediate: true,
    })

    return next(e)
  })

  on('command.run', { command: 'tiktok' }, async ($, e) => {
    const args = e.args.trim()

    // Logging in takes a real window: a QR code, a password manager, a
    // captcha. The pane's Chrome shares the profile, so it is logged in after.
    if (args === 'login') {
      if (viewer !== undefined) {
        await $.ui.close({ id: PANE })
      }

      await close($)
      await quit($)
      await settle($)
      await open($, LOGIN)

      return {
        text: 'Log in to TikTok in the window that opened, then close it and run /tiktok pane.',
      }
    }

    if (args === 'pane') {
      if (viewer !== undefined) {
        await $.ui.close({ id: PANE })

        return { text: 'TikTok pane closed.' }
      }

      const { isFullscreen, columns } = e.presentation
      const isDocked = isFullscreen && columns >= DOCK_COLUMNS

      await close($)
      await quit($)
      await settle($)
      void watch($, isDocked)
      await $.ui.open({ id: PANE, title: 'TikTok', columns: 46, rows: 60 })

      const where =
        isDocked
          ? 'at the side'
          : `above the prompt; from ${DOCK_COLUMNS} columns (now ${columns}) it docks at the side, full height`

      return {
        text: `TikTok pane opened ${where}. Click a control under the picture, or press ctrl+x tab to give the pane the keys. /tiktok pane again closes it; /tiktok login logs in.`,
      }
    }

    isEnabled = !isEnabled
    await $.store.set('isEnabled', isEnabled)

    if (isEnabled) {
      arm($)
    } else {
      await close($)
    }

    return { text: `TikTok breaks are ${isEnabled ? 'on' : 'off'}.` }
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    await unwatch()

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    if (e.surface !== 'terminal') {
      const { Text } = $.ui.resolve(e)

      return <Text>The TikTok pane draws in the terminal only.</Text>
    }

    const { Box, Button, Image } = $.ui.resolve(e)
    // The picture is fitted inside its box, so the box is all the room there
    // is. A docked pane's body is that room, less the rows of controls; an
    // inline block is only as tall as what is drawn in it, so there the
    // picture asks for half the terminal.
    const rows =
      e.props.placement === 'dock'
        ? e.props.scroll.bodyRows - controlRows(e.props.bodyColumns)
        : Math.max(8, Math.floor((e.viewport?.rows ?? 32) / 2))

    return (
      <Box flexDirection="column">
        <Image
          key="view"
          source={{ file: await frame($), format: 'png', generation }}
          columns={Math.max(1, Math.min(MAX_CELLS, e.props.bodyColumns))}
          rows={Math.max(1, Math.min(MAX_CELLS, rows))}
          alt="TikTok"
        />
        <Box columnGap={CONTROL_GAP} flexWrap="wrap">
          {CONTROLS.map(([hotkey, action, label]) => (
            <Button
              key={action}
              plain
              hotkey={hotkey}
              label={label}
              onPress={() => void send($, action)}
            />
          ))}
        </Box>
      </Box>
    )
  })

  on('turn.start', ($, e, next) => {
    isWorking = true
    arm($)

    return next(e)
  })

  // A prompt that needed the person closed the window; the next tool call
  // brings it back.
  on('tool.call', ($, e, next) => {
    arm($)

    return next(e)
  })

  on('classic.Notification', async ($, e, next) => {
    if (await close($)) {
      $.ui.toast('Claude needs you')
    }

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      isWorking = false

      if (await close($)) {
        $.ui.toast('Claude is done. Back to work.')
      }
    }

    return next(e)
  })
}
