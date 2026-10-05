import type { EngineInterface, Register } from 'claude-code'

const LOGIN = 'https://www.tiktok.com/login'
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

// The viewer feeding the pane, while it runs.
let viewer: ReturnType<EngineInterface['process']['spawn']> | undefined
let generation = 0

const FIND = `
case $(uname) in
  Darwin)
    echo "$HOME/Library/Application Support/tiktok-break"
    app=$(osascript -l JavaScript -e 'ObjC.import("AppKit"); const u = $.NSWorkspace.sharedWorkspace.URLForApplicationToOpenURL($.NSURL.URLWithString("https://www.tiktok.com")); u.isNil() ? "" : u.path.js' 2>/dev/null)
    ls "$app/Contents/Frameworks" 2>/dev/null | grep -q ' Framework\\.framework$' &&
      b="$app/Contents/MacOS/$(defaults read "$app/Contents/Info" CFBundleExecutable)" ;;
  *)
    echo "\${XDG_CONFIG_HOME:-$HOME/.config}/tiktok-break"
    id=$(xdg-settings get default-web-browser 2>/dev/null)
    for d in "\${XDG_DATA_HOME:-$HOME/.local/share}" $(echo "\${XDG_DATA_DIRS:-/usr/local/share:/usr/share}" | tr : ' '); do
      [ -n "$id" ] && [ -f "$d/applications/$id" ] && b=$(sed -n 's/^Exec=\\([^ ]*\\).*/\\1/p' "$d/applications/$id" | head -n 1) && break
    done
    "$b" --version 2>/dev/null | grep -Eq '[0-9]+\\.[0-9]+\\.[0-9]+\\.[0-9]+' || b= ;;
esac
command -v "$b" || echo
`

let located: Promise<{ profile: string; browser: string }> | undefined

function locate($: EngineInterface) {
  located ??= $.process.run(['sh', '-c', FIND]).then(({ stdout }) => {
    const [dir = '', binary = ''] = stdout.split('\n')

    return { profile: dir, browser: binary }
  })

  return located
}

async function profile($: EngineInterface) {
  return (await locate($)).profile
}

async function findBrowser($: EngineInterface) {
  const found = (await locate($)).browser

  if (!found) {
    $.ui.toast('tiktok-break: set a Chromium-based browser (Chrome, Chromium, Brave, Edge, Helium, Vivaldi…) as your default; Firefox and Safari cannot drive the pane')

    return undefined
  }

  return found
}

async function frame($: EngineInterface) {
  return `${await profile($)}/pane-frame.png`
}

async function socket($: EngineInterface) {
  return `${await profile($)}/pane.sock`
}

// The browser runs on a profile of its own, so the window is a process this
// mod can end without touching the person's own browser. The shell returns
// before the browser does, so it waits a second to catch one that dies at
// startup, and keeps the browser's output in the profile to show then. On a
// first run the profile does not exist yet, so the log needs it made first.
const LAUNCH = `
log=$1; shift
mkdir -p "\${log%/*}" || exit
"$@" >"$log" 2>&1 &
sleep 1
kill -0 $! 2>/dev/null || { wait $!; s=$?; cat "$log" >&2; exit $s; }
`

// Resolves whether the window came up.
async function open($: EngineInterface, url: string) {
  const binary = (await locate($)).browser
  const dir = await profile($)
  const { exitCode, stderr } = await $.process.run([
    'sh',
    '-c',
    LAUNCH,
    'sh',
    `${dir}/launch.log`,
    binary,
    `--app=${url}`,
    `--user-data-dir=${dir}`,
    '--window-size=430,900',
    '--no-first-run',
    '--no-default-browser-check',
  ])

  if (exitCode !== 0) {
    $.ui.toast(`tiktok-break: could not open ${binary}: ${stderr.trim().split('\n').at(-1) ?? ''}`)
  }

  return exitCode === 0
}

// Whether any browser runs on the mod's profile: a window, or the pane's.
async function isBusy($: EngineInterface) {
  const { exitCode } = await $.process.run([
    'pgrep',
    '-f',
    '--',
    `--user-data-dir=${await profile($)}`,
  ])

  return exitCode === 0
}

// Ends a window on the mod's profile; resolves true when one was up.
async function quit($: EngineInterface) {
  const { exitCode } = await $.process.run([
    'pkill',
    '-f',
    '--',
    `--app=[^ ]* --user-data-dir=${await profile($)}`,
  ])

  return exitCode === 0
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
async function watch($: EngineInterface, binary: string, isDocked: boolean) {
  const file = await frame($)
  const frames = $.process.spawn({
    argv: [
      'bun',
      `${$.plugin.root}/viewer/viewer.ts`,
      await profile($),
      file,
      await socket($),
      isDocked ? 'item' : 'video',
      binary,
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
    await $.command.register({
      name: 'tiktok',
      description: 'Play TikTok in a side pane; "login" opens a window to log in',
      argumentHint: '[login]',
      immediate: true,
    })

    return next(e)
  })

  on('command.run', { command: 'tiktok' }, async ($, e) => {
    // Logging in takes a real window: a QR code, a password manager, a
    // captcha. The pane's Chrome shares the profile, so it is logged in after.
    if (e.args.trim() === 'login') {
      if (viewer !== undefined) {
        await $.ui.close({ id: PANE })
      }

      if (!(await findBrowser($))) {
        return { text: 'No Chromium browser is your default browser to log in with.' }
      }

      await quit($)
      await settle($)
      if (!(await open($, LOGIN))) {
        return { text: 'The login window did not open.' }
      }

      return {
        text: 'Log in to TikTok in the window that opened, then close it and run /tiktok.',
      }
    }

    if (viewer !== undefined) {
      await $.ui.close({ id: PANE })

      return { text: 'TikTok pane closed.' }
    }

    const binary = await findBrowser($)

    if (!binary) {
      return { text: 'No Chromium browser is your default browser to play TikTok in.' }
    }

    const { isFullscreen, columns } = e.presentation
    const isDocked = isFullscreen && columns >= DOCK_COLUMNS

    await quit($)
    await settle($)
    void watch($, binary, isDocked)
    await $.ui.open({ id: PANE, title: 'TikTok', columns: 46, rows: 60 })

    const where = isDocked
      ? 'at the side'
      : `above the prompt; from ${DOCK_COLUMNS} columns (now ${columns}) it docks at the side, full height`

    return {
      text: `TikTok pane opened ${where}. Click a control under the picture, or press ctrl+x tab to give the pane the keys. /tiktok again closes it; /tiktok login logs in.`,
    }
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
}
