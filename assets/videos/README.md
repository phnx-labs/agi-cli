# Demo clips

Short real-terminal captures embedded in `docs/*.md`. Each clip is **6–15 seconds**, **silent**, **autoplay-loop-friendly**, and **under ~400 KB** so the docs site stays fast.

Embed pattern in markdown:

```html
<video autoplay loop muted playsinline width="100%" src="../assets/videos/profiles.mp4"></video>
```

---

## Slot list

One clip per feature doc. Storyboard is "show the command, show the result." No narration, no music bed — terminals on docs pages should feel like quick GIFs that happen to be MP4s.

| Slot file | Doc page | Storyboard |
|---|---|---|
| `profiles.mp4` | [`docs/profiles.md`](../../docs/profiles.md) | `agents profiles presets` → `agents profiles add kimi` (keychain prompt) → `agents run kimi "haiku about pinning"` |
| `secrets.mp4` | [`docs/secrets.md`](../../docs/secrets.md) | `secrets create openai` → `secrets add openai OPENAI_API_KEY` → `secrets exec openai env \| grep OPENAI` |
| `teams.mp4` | [`docs/teams.md`](../../docs/teams.md) | `agents teams create demo` → two `teams add` → `teams start --watch` (DAG wave visible) |
| `cloud.mp4` | [`docs/cloud.md`](../../docs/cloud.md) | `agents cloud run "rename X→Y" --provider rush` → SSE stream tail |
| `browser.mp4` | [`docs/browser.md`](../../docs/browser.md) | `browser profiles create gmail` → `browser start gmail` → `browser screenshot` (open JPG) |
| `pty.mp4` | [`docs/pty.md`](../../docs/pty.md) | `agents pty start py` → `agents pty exec py "import this"` → `agents pty read py` |
| `computer.mp4` | [`docs/computer.md`](../../docs/computer.md) | `computer screenshot` → `computer click "Send"` |
| `plugins.mp4` | [`docs/plugins.md`](../../docs/plugins.md) | `agents plugins install <github-url>` → exec-surface consent → `agents plugins list` |
| `workflows.mp4` | [`docs/workflows.md`](../../docs/workflows.md) | `agents workflows list` → `agents workflows view <name>` (WORKFLOW.md) |
| `subagents.mp4` | [`docs/subagents.md`](../../docs/subagents.md) | `agents subagents list` → `agents subagents view <name>` (frontmatter + tools) |
| `hooks.mp4` | [`docs/hooks.md`](../../docs/hooks.md) | `agents hooks list` → `agents hooks view session-start` (predicate matchers) |

Anyone landing a new doc should add the matching slot, even if the MP4 isn't recorded yet — the empty path is the TODO marker.

---

## Recording pipeline

The animator skill at `~/.agents/skills/animator/` already has the ffmpeg recipes; this guide just chains them for these specific clips.

### One-time setup

```bash
brew install ffmpeg                                       # if not already
agents skills add animator                                # ensures the skill is on disk
```

For the terminal itself, use **Ghostty** or **iTerm2** with a tight monospace theme — JetBrains Mono 13pt, two-character left padding, no shell prompt clutter. The agi-cli homepage hero (`assets/demo.mp4`) was captured this way; match its look.

### Capture

Default: native `screencapture` so the terminal chrome and font rendering are real.

```bash
# 1. Set up a clean window: ~120 cols × 32 rows, fresh prompt.
# 2. Start capture (Cmd+Shift+5 → "Record selected portion" → tight crop around the window).
# 3. Run the storyboard. Pause briefly between commands so silence-cut can find the gaps.
# 4. Stop capture. Output lands at ~/Movies/Screen Recording <date>.mov.
mv "$HOME/Movies/Screen Recording"*.mov /tmp/raw-profiles.mov
```

Alternative: `asciinema rec` if you want a pure-text cast (smaller files, no terminal chrome). Convert with `agg` to GIF/MP4 if you go this route.

### Polish (ffmpeg recipes lifted from `~/.agents/skills/animator/RECIPES.md`)

```bash
RAW=/tmp/raw-profiles.mov
OUT=assets/videos/profiles.mp4

# Trim to the actual demo window.
ffmpeg -y -ss 0:02 -to 0:14 -i "$RAW" \
  -c:v libx264 -preset medium -crf 20 -an /tmp/trim.mp4

# Drop silent gaps. Skip if you didn't pause between commands.
ffmpeg -y -i /tmp/trim.mp4 \
  -af "silenceremove=start_periods=1:start_duration=0:start_threshold=-30dB:stop_periods=-1:stop_duration=0.4:stop_threshold=-30dB" \
  -c:v copy -an /tmp/tight.mp4

# Selectively 2x boring stretches (optional — only if the run drags).
ffmpeg -y -i /tmp/tight.mp4 \
  -filter_complex "[0:v]setpts=0.5*PTS[v]" -map "[v]" -c:v libx264 -crf 20 -an /tmp/fast.mp4

# Downscale 4K→1080p with faststart so docs pages can stream-decode.
ffmpeg -y -i /tmp/fast.mp4 \
  -vf "scale=1920:-2:flags=lanczos" \
  -c:v libx264 -preset slow -crf 23 -movflags +faststart -an "$OUT"
```

The result should sit at **6–15s** and **under 400 KB**. If it's bigger, raise `-crf` to 26 or scale to 1280×-2.

### Verify visually

You cannot trust MP4 encoders by eye — always extract frames first.

```bash
agents run animator -- preview "$OUT" --frames 5
ls ~/.agents/skills/animator/out/preview/$(basename "$OUT" .mp4)/
# open each frame-*.jpg, check first/middle/last for cropping, mojibake, leaked secrets
```

If a frame shows a real API key, prompt, or path you don't want in public, re-record. Once committed, even a force-push leaves history.

### Commit

```bash
git add assets/videos/<feature>.mp4
git commit -m "docs(<feature>): add demo clip"
```

---

## Checklist before a clip lands

- [ ] Under 400 KB, 6–15s, 1080p or smaller.
- [ ] No keys, tokens, real customer data, or private repo paths visible in any frame.
- [ ] Plays cleanly on loop (no visible cut between last and first frame).
- [ ] Embeds with `<video autoplay loop muted playsinline width="100%">` — no audio track.
- [ ] Frame-extracted preview reviewed.
- [ ] Filename matches the slot list above.

## Why MP4 not GIF

Modern Safari, Chrome, and Firefox autoplay muted MP4s as cheaply as GIFs, and a 200 KB MP4 looks like a 3 MB GIF. The docs site stays under 1 MB per page even with five embedded clips, which keeps it indexable by users on slow networks. The agi-cli homepage hero (`assets/demo.mp4`) is the same approach scaled up.
