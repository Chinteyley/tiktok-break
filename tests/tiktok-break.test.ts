import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const SESSION = { cwd: '/repo', surface: 'terminal', isInteractive: true } as const

// The host beneath the mod: a clock the test moves, and every command it runs
// recorded instead of done.
function host(on: On) {
  const clock = mock.clock(on)
  mock.store(on)
  mock.env(on, { HOME: '/Users/u' })

  const runs: string[] = []
  const argvs: (readonly string[])[] = []
  on('process.run', ($, e) => {
    const [name = ''] = e.argv
    const isUp = runs.includes('open')
    runs.push(name)
    argvs.push(e.argv)

    return {
      value: {
        // pgrep and pkill find a Chrome only once a window was opened.
        exitCode: (name === 'pgrep' || name === 'pkill') && !isUp ? 1 : 0,
        stdout: '',
        stderr: '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }
  })
  on('ui.toast', () => ({ value: undefined }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))

  return { clock, runs, argvs }
}

test('the command runs the viewer and draws its frames as a picture', async ($, on) => {
  const { clock } = host(on)

  const spawned: string[] = []
  const blits: number[] = []
  on('process.spawn', async function* ($, e) {
    spawned.push(`${e.argv[0]} ${e.argv.at(-1)}`)
    yield { stream: 'stdout', text: 'frame\n' }

    return { value: { code: 0, signal: null } }
  })
  const pressed: (string | undefined)[] = []
  on('http.fetch', ($, e) => {
    pressed.push(e.init?.body)

    return { value: { status: 200, ok: true, headers: {}, text: 'ok' } }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.blit', ($, e) => {
    blits.push('source' in e && 'generation' in e.source ? (e.source.generation ?? 0) : 0)

    return { value: {} }
  })

  await $.session.start(SESSION)
  await $.command.run({
    command: 'tiktok',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 200 },
  })
  await clock.settle()
  // A terminal wide enough to dock the pane frames videos with their item.
  expect(spawned).toEqual(['bun item'])
  expect(blits).toEqual([1])

  // Docked, the picture's box is the pane's body less the controls, which
  // wrap to two rows at this width; inline, where the block is as tall as its
  // content, it is half the terminal's rows.
  const pane = { plugin: 'tiktok-break', surface: 'terminal', component: 'Pane', requestId: 'tiktok' } as const
  const props = { title: 'TikTok', isFocused: false, view: {} }
  const docked = await $.ui.mount({
    ...pane,
    props: { ...props, bodyColumns: 46, placement: 'dock', scroll: { offset: 0, bodyRows: 26 } },
  })
  expect((await docked.find({ type: 'Image' }))?.props).toMatchObject({ columns: 46, rows: 24 })
  await docked.press({ key: 'next' })
  await docked.press({ key: 'repost' })
  expect(pressed).toEqual(['next', 'repost'])
  await docked.unmount()

  const inline = await $.ui.mount({
    ...pane,
    props: { ...props, bodyColumns: 93, placement: 'inline', scroll: { offset: 0, bodyRows: 1 } },
    viewport: { columns: 97, rows: 31, isFullscreen: true },
  })
  expect((await inline.find({ type: 'Image' }))?.props).toMatchObject({ columns: 93, rows: 15 })
})

test('the login command opens a real window on the login page', async ($, on) => {
  const { runs, argvs } = host(on)

  await $.session.start(SESSION)
  await $.command.run({
    command: 'tiktok',
    args: 'login',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 200 },
  })

  expect(runs).toEqual(['pkill', 'pgrep', 'open'])
  expect(argvs.at(-1)).toContain('--app=https://www.tiktok.com/login')
})
