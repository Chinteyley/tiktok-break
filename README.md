# tiktok-break

Watch TikTok inside Claude Code while Claude works, in a pane beside the
transcript.

Unofficial. Not affiliated with TikTok or Anthropic.

## Commands

| Command | What it does |
| --- | --- |
| `/tiktok` | Plays your For You feed in a pane; run it again to close. |
| `/tiktok login` | Opens a real Chrome window on the mod's profile so you can log in. Close it, then run `/tiktok`. |

**The pane** docks at the side, full height, when Claude Code is in its
fullscreen layout and the terminal is at least 110 columns wide. In a smaller
terminal it is a block above the prompt. Docked, a video is framed with its
creator, likes, comments, saves and shares; above the prompt, the video alone.

### Pane controls

Click a control under the picture, or press ctrl+x tab to give the pane the
keyboard and use its key. Esc hands the keyboard back to the prompt.

| Key | Control |
| --- | --- |
| `k` | Previous video |
| `j` | Next video |
| `p` | Pause or play |
| `m` | Mute or unmute |
| `l` | Like |
| `r` | Repost (again takes it back) |

A video that finishes moves on to the next by itself. Like and Repost are real
actions on the account you logged in with.

## Requirements

- macOS
- Google Chrome in `/Applications`
- [Bun](https://bun.sh) on your `PATH`
- For the pane, a terminal that draws the kitty graphics protocol. Built and
  tested in Ghostty; kitty should work but is untested.
- Claude Code with function-hook mods. Built against 2.1.289; that API is
  early access and may change between releases.

## Install

```sh
git clone https://github.com/Chinteyley/tiktok-break
claude --plugin-dir ./tiktok-break
```

## How it works

`viewer/viewer.ts` runs a headless Chrome on a profile of its own
(`~/Library/Application Support/tiktok-break`), opens the For You feed and
screencasts it over the DevTools protocol. Each frame is written to one PNG
file, and the mod (`hooks/register.tsx`) repaints the pane's picture from that
file through the terminal's graphics protocol. The controls go the other way
over a Unix socket: the viewer presses TikTok's own keyboard shortcuts in the
page. Sound comes from that Chrome.

`/tiktok login` opens a plain Chrome app window on the same profile, which is
how the pane comes to be logged in.

## Good to know

- **Automation and TikTok's terms.** TikTok drops likes from a browser that
  says it is automated, so the viewer's Chrome is started to report a regular
  Chrome name with the automation flag off. That gets around TikTok's
  automation check on your account, and TikTok could restrict the account for
  it. Use it at your own risk.
- **Disk writes.** Frames are PNG files of roughly half a megabyte, written
  about 30 times a second while the pane plays.
- **Photo posts** are shown with their whole item and do not move on by
  themselves; press Next.
- **Clicks and typing** inside the picture are not possible. Use the
  `/tiktok login` window for comments and search.
- **Logged out,** TikTok covers the feed with a login dialog after a few
  videos. The pane shows the dialog; run `/tiktok login`.

## Development

```sh
claude plugin validate .
claude plugin test .
tsc -p .
```

`tsc` needs the type declarations Claude Code lays into `.claude-plugin/types/`
the first time it loads the mod; that folder is not checked in.

## License

MIT
