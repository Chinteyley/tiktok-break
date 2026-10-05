// Plays the TikTok feed in a headless Chrome and writes what it shows to one
// PNG file, frame after frame; each line on stdout says a new frame is there.
// The pane's controls reach it on a Unix socket, one action a request. The mod
// runs it with bun: viewer.ts <profile dir> <frame path> <socket path> <framing>
// <browser>, the framing `video` (the video alone) or `item` (with its likes and
// creator), the browser any Chromium one.
import { lstatSync, rmSync } from 'node:fs'
import { rename } from 'node:fs/promises'

const FEED = 'https://www.tiktok.com/foryou'
// The size the page is laid out at, and how much sharper than that a frame is.
const PAGE = { width: 500, height: 800, deviceScaleFactor: 1, mobile: false }
const SCALE = 1.5
// An item at its tallest, a 9:16 video beside the column of its creator and
// counts, is this many times as tall as it is wide.
const ITEM_SHAPE = 618 / 404
const ITEM_MARGIN = 8
// What is on the page now: a dialog over the feed (TikTok asking for a login),
// or the item in view: its video when it has one (a photo post has none), and
// its content, the box holding its picture and the column beside it.
const LOOK = `(() => {
  const box = node => {
    const { x, y, width, height } = node.getBoundingClientRect()
    return { x, y, width, height }
  }
  const isShown = node => node.getBoundingClientRect().height > 0
  if ([...document.querySelectorAll('[role="dialog"]')].some(isShown)) return {}
  const middle = innerHeight / 2
  const item = [...document.querySelectorAll('article')].find(one => {
    const { top, bottom } = one.getBoundingClientRect()
    return top <= middle && bottom >= middle
  })
  if (!item) return {}
  let content = item.querySelector('[data-e2e="like-icon"]')
  while (content && content !== item && content.getBoundingClientRect().width < 250) {
    content = content.parentElement
  }
  const video = item.querySelector('video')
  return {
    item: box(item),
    content: content ? box(content) : undefined,
    video: video ? box(video) : undefined,
    time: video?.currentTime,
    src: video?.currentSrc,
  }
})()`
// Reposting has no key: it is the first entry of the share panel of the item
// in view, which takes a moment to open. The same entry takes a repost back.
const REPOST = `(async () => {
  const middle = innerHeight / 2
  const item = [...document.querySelectorAll('article')].find(one => {
    const { top, bottom } = one.getBoundingClientRect()
    return top <= middle && bottom >= middle
  })
  item?.querySelector('[data-e2e="share-icon"]')?.click()
  for (let i = 0; i < 20; i++) {
    const repost = document.querySelector('[data-e2e="share-repost"]')
    if (repost) return repost.click()
    await new Promise(resolve => setTimeout(resolve, 100))
  }
})()`
// TikTok's own keyboard shortcuts, by the pane's name for each.
const KEYS: Record<string, object> = {
  next: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
  prev: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
  pause: { key: ' ', code: 'Space', windowsVirtualKeyCode: 32 },
  mute: { key: 'm', code: 'KeyM', windowsVirtualKeyCode: 77 },
  like: { key: 'l', code: 'KeyL', windowsVirtualKeyCode: 76 },
}

interface Box {
  x: number
  y: number
  width: number
  height: number
}

interface Look {
  video?: Box
  content?: Box
  item?: Box
  time?: number
  src?: string
}

const [profile, frame, socketPath, framing, browser] = process.argv.slice(2)

if (!profile || !frame || !socketPath || !framing || !browser) {
  throw new Error('usage: viewer.ts <profile dir> <frame path> <socket path> <video|item> <browser>')
}

// The box of one shape around another, on its centre: frames keep one shape
// from item to item, so the picture does not jump about in the pane.
const around = ({ x, y, width, height }: Box, shape: number, margin: number): Box => {
  const wide = Math.max(width, height / shape) + margin * 2
  const tall = Math.max(height, width * shape) + margin * 2

  return {
    x: x + width / 2 - wide / 2,
    y: y + height / 2 - tall / 2,
    width: wide,
    height: tall,
  }
}

const isLocked = () => {
  try {
    lstatSync(`${profile}/SingletonLock`)

    return true
  } catch {
    return false
  }
}

// A window closing on the same profile holds its lock for a moment more.
for (let i = 0; i < 30 && isLocked(); i++) {
  await Bun.sleep(100)
}

// TikTok answers a like from a browser that says it is automated with
// nothing, and the page takes the like back. The person asked for the pane's
// Chrome to say what a Chrome window says: its usual name, with no "Headless"
// in it, and no automation flag.
const version = new TextDecoder().decode(Bun.spawnSync([browser, '--version']).stdout)
const major = /(\d+)\./.exec(version)?.[1]

if (!major) {
  throw new Error(`Chrome did not say its version: ${version}`)
}

const chrome = Bun.spawn(
  [
    browser,
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    `--user-agent=Mozilla/5.0 (${process.platform === 'darwin' ? 'Macintosh; Intel Mac OS X 10_15_7' : 'X11; Linux x86_64'}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`,
    '--disable-blink-features=AutomationControlled',
    '--autoplay-policy=no-user-gesture-required',
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank',
  ],
  { stdout: 'ignore', stderr: 'pipe' },
)

// However this ends, Chrome ends with it: left alone it would play on unseen.
process.on('exit', () => chrome.kill())
process.on('SIGTERM', () => process.exit(0))
process.on('SIGINT', () => process.exit(0))

let port: string | undefined
const decoder = new TextDecoder()

for await (const piece of chrome.stderr) {
  port = /ws:\/\/127\.0\.0\.1:(\d+)\//.exec(decoder.decode(piece))?.[1]

  if (port) {
    break
  }
}

if (!port) {
  throw new Error('Chrome ended before its DevTools port opened')
}

// Some browsers (Brave) open the port before the first page is listed.
let page: { type: string; webSocketDebuggerUrl: string } | undefined

for (let i = 0; i < 50 && !page; i++) {
  const targets: { type: string; webSocketDebuggerUrl: string }[] = await (
    await fetch(`http://127.0.0.1:${port}/json/list`)
  ).json()
  page = targets.find(target => target.type === 'page')

  if (!page) {
    await Bun.sleep(100)
  }
}

if (!page) {
  throw new Error('Chrome opened no page')
}

const socket = new WebSocket(page.webSocketDebuggerUrl)
await new Promise(resolve => {
  socket.onopen = resolve
})

let lastId = 0
const answers = new Map<number, (result: unknown) => void>()
const call = (method: string, params: object = {}) =>
  new Promise<unknown>(resolve => {
    lastId += 1
    answers.set(lastId, resolve)
    socket.send(JSON.stringify({ id: lastId, method, params }))
  })

const press = async (key: object) => {
  await call('Input.dispatchKeyEvent', { type: 'keyDown', ...key })
  await call('Input.dispatchKeyEvent', { type: 'keyUp', ...key })
}

let isWriting = false

socket.onmessage = async event => {
  const message = JSON.parse(String(event.data))

  if (message.id !== undefined) {
    answers.get(message.id)?.(message.result)
    answers.delete(message.id)

    return
  }

  if (message.method !== 'Page.screencastFrame') {
    return
  }

  void call('Page.screencastFrameAck', { sessionId: message.params.sessionId })

  // A frame that arrives while the last is still being written is dropped.
  if (isWriting) {
    return
  }

  isWriting = true
  await Bun.write(`${frame}.next`, Buffer.from(message.params.data, 'base64'))
  await rename(`${frame}.next`, frame)
  isWriting = false
  console.log('frame')
}

await call('Emulation.setDeviceMetricsOverride', PAGE)
// Started before the page is: a screencast asked for as the navigation lands
// is lost with the blank page's renderer and never sends a frame.
await call('Page.startScreencast', { format: 'png', everyNthFrame: 1 })
await call('Page.navigate', { url: FEED })

rmSync(socketPath, { force: true })
Bun.serve({
  unix: socketPath,
  async fetch(request) {
    const action = await request.text()
    const key = KEYS[action]

    if (key) {
      await press(key)
    } else if (action === 'repost') {
      await call('Runtime.evaluate', { expression: REPOST, awaitPromise: true })
    } else {
      return new Response('unknown action', { status: 400 })
    }

    return new Response('ok')
  },
})

let lastClip = ''
let lastTime = 0
let lastSrc: string | undefined

setInterval(async () => {
  // The session that ran this is gone: nothing reads the frames any more.
  if (process.ppid === 1) {
    process.exit(0)
  }

  const { result } = (await call('Runtime.evaluate', {
    expression: LOOK,
    returnByValue: true,
  })) as { result: { value: Look } }
  const { video, content, item, time, src } = result.value
  // A dialog, or nothing yet, is framed by the whole page. Under the `video`
  // framing a video is framed alone, by the 9:16 box around it; otherwise, and
  // for a photo post, the frame is the item's content.
  let clip: Box = item ?? { x: 0, y: 0, width: PAGE.width, height: PAGE.height }

  if (video && framing === 'video') {
    clip = around(video, 16 / 9, 0)
  } else if (content) {
    clip = around(content, ITEM_SHAPE, ITEM_MARGIN)
  }

  const viewport = {
    x: Math.round(clip.x),
    y: Math.round(clip.y),
    width: Math.round(clip.width),
    height: Math.round(clip.height),
    scale: SCALE,
  }

  if (JSON.stringify(viewport) !== lastClip) {
    lastClip = JSON.stringify(viewport)
    await call('Emulation.setDeviceMetricsOverride', { ...PAGE, viewport })
  }

  // TikTok loops a video for ever; a feed nobody scrolls moves on by itself.
  // Only the same video starting over is a loop: another one starting, after
  // Next or Prev, is not.
  if (time !== undefined && src === lastSrc && time < lastTime - 1) {
    await press(KEYS.next!)
  }

  lastTime = time ?? 0
  lastSrc = src
}, 500)
