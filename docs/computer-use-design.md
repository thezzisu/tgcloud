# Computer Use API Design

Design document for adding **computer use** (screenshot + mouse/keyboard control)
to the tgcloud panel, so an AI agent can drive the GUI desktop inside a KasmVNC
instance container. Modeled on Anthropic's computer use tool specification.

---

## 0. Findings from the existing codebase

These constrain the design and are reused rather than reinvented:

| Fact | Source | Implication |
|------|--------|-------------|
| Instance containers run `lscr.io/linuxserver/baseimage-kasmvnc:debianbookworm` (Xvfb + openbox + KasmVNC), exposing `3000/tcp` (HTTP) / `3001` (HTTPS). | `images/wechat/Dockerfile`, `3rd/.../docker/Dockerfile` | X11 display, not a real GPU. Screenshots come from the Xvfb framebuffer. |
| The X display is **`:1`**. | `3rd/.../docker/autostart`: `export DISPLAY="${DISPLAY:-:1}"` | All `xdotool`/`import` commands must run with `DISPLAY=:1`. |
| `xdotool` and `xclip` are already installed; CJK fonts present. | `images/wechat/Dockerfile` (`xdotool xclip`, `fonts-noto-cjk` …) | Mouse/keyboard + clipboard available. **No ImageMagick/scrot yet** → must add a screenshot tool. |
| A **proven CJK input path already exists**: `typeInInstance()` base64 → `xclip -selection clipboard` → `xdotool key ctrl+v`. | `3rd/.../panel/server/src/docker.ts` | Reuse this exact strategy for Unicode/CJK `type`. |
| `execInContainer(inst, cmd, {user, timeout})` → `{ok, stdout, stderr, exitCode}` (demuxes to **UTF-8 strings**). | `overlay/server/src/tg-exec.ts` | Use for all text commands. **Not safe for binary** (corrupts bytes) → screenshots must be read via file, not stdout. |
| `readFileFromContainer(inst, path)` → `Buffer` (via `getArchive` tar). | `tg-exec.ts` | Use to pull the screenshot file out as raw bytes. |
| PAT auth + per-instance access already implemented (`agentAuth`, `getInstanceOrFail`). | `overlay/server/src/agent.ts` | New endpoints plug straight into this. |
| KasmVNC framebuffer resolution is **dynamic** (resizes to the connected browser; a default geometry when headless). | linuxserver KasmVNC base | We must read the *actual* geometry at runtime and scale coordinates — do not assume a fixed size. |

**Architecture decision:** implement computer use as a thin overlay module
(`computer.ts`) registered the same way as `agent.ts`, executing `xdotool` /
screenshot commands inside the target container via `dockerode` exec — exactly
the pattern the panel already uses for tg and `typeInInstance`. The agent never
talks to the container directly; the panel is the trusted intermediary.

---

## 1. Anthropic computer use tool specification (summary)

### 1.1 Tool versions

| Tool type | Beta header | Models |
|-----------|-------------|--------|
| `computer_20251124` | `computer-use-2025-11-24` | Opus 4.8 / 4.7 / 4.6, Sonnet 4.6, Opus 4.5 |
| `computer_20250124` | `computer-use-2025-01-24` | Sonnet 4.5, Haiku 4.5, Opus 4.1 (+ deprecated Sonnet 4 / Opus 4) |

Tool definition declared to the API (the model needs the display size):

```json
{
  "type": "computer_20250124",
  "name": "computer",
  "display_width_px": 1024,
  "display_height_px": 768,
  "display_number": 1
}
```

`computer_20251124` adds `enable_zoom: true` (lets Claude request a zoomed crop
for small text). Our REST surface is version-agnostic; the *calling* agent picks
the tool version and our endpoints implement the superset of actions.

### 1.2 Action set (`computer_20250124`, verified against `@ai-sdk/anthropic`)

Input schema fields: `action` (required), `coordinate [x,y]`, `start_coordinate
[x,y]`, `text`, `scroll_direction up|down|left|right`, `scroll_amount` (clicks),
`duration` (seconds).

| action | params | meaning |
|--------|--------|---------|
| `screenshot` | – | capture current screen |
| `cursor_position` | – | return current `(x,y)` |
| `mouse_move` | `coordinate` | move pointer |
| `left_click` | `coordinate`, opt. `text` (modifiers held) | click |
| `right_click` | `coordinate` | right click |
| `middle_click` | `coordinate` | middle click |
| `double_click` | `coordinate` | double click |
| `triple_click` | `coordinate` | triple click |
| `left_click_drag` | `start_coordinate`, `coordinate` | press-drag-release |
| `left_mouse_down` | `coordinate` | press & hold (low-level) |
| `left_mouse_up` | `coordinate` | release (low-level) |
| `key` | `text` (e.g. `ctrl+s`, `Return`) | keystroke / chord |
| `hold_key` | `text`, `duration` | hold key for N seconds |
| `type` | `text` | type a string |
| `scroll` | `coordinate`, `scroll_direction`, `scroll_amount` | scroll at point |
| `wait` | `duration` | pause |

(`computer_20241022`, the older Sonnet 3.5 version, omits
`left_mouse_down/up`, `triple_click`, `scroll`, `hold_key`, `wait` — we accept
those too but the modern set above is the target.)

### 1.3 Coordinate system

- Origin **top-left `(0,0)`**, X right, Y down, integer pixels.
- Coordinates are expressed in the **declared `display_width/height_px`**, *not*
  necessarily the real framebuffer size. Anthropic's reference implementation
  scales between the two (`ScalingSource.API` ↔ `ScalingSource.COMPUTER`).
- **Recommended display sizes (do not exceed):** images larger than ~XGA hurt
  accuracy and cost more tokens. Targets:
  - `XGA` 1024×768 (4:3)
  - `WXGA` 1280×800 (16:10)
  - `FWXGA` 1366×768 (~16:9)

### 1.4 Screenshot format Claude expects

- A standard raster image returned in the `tool_result` as an image block.
- PNG or JPEG both accepted; **JPEG is preferred for token efficiency** for
  photographic/desktop content. Keep the long edge ≤ ~1280 px.
- Returned to the API as base64 inside an image content block:

```json
{ "type": "image",
  "source": { "type": "base64", "media_type": "image/jpeg", "data": "<b64>" } }
```

### 1.5 tool_use / tool_result flow (agent loop)

1. Caller sends a message with the `computer` tool defined + beta header.
2. Claude replies with `stop_reason: "tool_use"` and a `tool_use` block:
   `{ id, name: "computer", input: { action, coordinate, ... } }`.
3. Caller executes the action (→ **our panel endpoint**), captures the result
   (text and/or a screenshot).
4. Caller sends a `user` message with a `tool_result` block referencing
   `tool_use_id`, containing text and/or the screenshot image block.
5. Repeat 2–4 until Claude responds with no tool use (done) or a max-iteration
   cap is hit. **Place instruction text before the image** in each turn for
   better click accuracy.

---

## 2. Proposed REST API for the panel

All endpoints sit under the existing PAT-authed namespace and reuse
`agentAuth` + `getInstanceOrFail`. Errors follow the existing
`{ error, message }` shape with the same HTTP codes (401/403/404/400/502).

### 2.1 Primary endpoint — execute one action

```
POST /api/agent/instances/:id/computer
Authorization: Bearer tgcp_...
Content-Type: application/json
```

Request body mirrors Anthropic's tool input verbatim, so a calling agent can
forward `tool_use.input` with zero translation:

```jsonc
{
  "action": "left_click",          // required, one of the actions in §1.2
  "coordinate": [512, 380],        // [x,y] in the *scaled* display space
  "start_coordinate": [10, 20],    // for left_click_drag
  "text": "ctrl+s",               // for key/hold_key/type, or click modifiers
  "scroll_direction": "down",
  "scroll_amount": 3,
  "duration": 1.5,
  "screenshot": true               // OPTIONAL extension: auto-capture after action
}
```

Response (action that returns a screenshot, e.g. `screenshot`, or any action
with `screenshot:true` — the default for mutating actions, see §2.3):

```jsonc
{
  "ok": true,
  "action": "left_click",
  "image": {                       // present when a screenshot was taken
    "media_type": "image/jpeg",
    "data": "<base64>",
    "width": 1024,                 // scaled (== display_width_px)
    "height": 768
  },
  "output": "",                    // stdout from the tool, if any
  "cursor": { "x": 512, "y": 380 } // for cursor_position
}
```

The `image` object is shaped so the caller can drop it straight into a
`tool_result` image block. On failure: `{ ok:false, error, message }` with 4xx/5xx.

### 2.2 Helper endpoint — display info / tool descriptor

```
GET /api/agent/instances/:id/computer/display
```

```jsonc
{
  "display_number": 1,
  "actual": { "width": 1280, "height": 720 },   // real Xvfb framebuffer
  "scaled": { "width": 1024, "height": 576 },    // what the agent should use
  "recommended_tool": {
    "type": "computer_20250124",
    "name": "computer",
    "display_width_px": 1024,
    "display_height_px": 576,
    "display_number": 1
  }
}
```

Lets the calling agent build the correct tool definition (`display_width_px`
must equal the scaled width the panel will scale *from*). A plain
`GET /computer/screenshot` returning `image/jpeg` binary is also offered for
debugging/humans.

### 2.3 Screenshot-return policy

To match the reference loop (every mutating action is followed by a screenshot),
the default is: `screenshot`, `cursor_position` and `wait` aside, **every action
returns a fresh screenshot** after a short settle delay (default 2 s, adjustable
via `?settle_ms=`), unless the request sets `"screenshot": false`. This keeps the
agent loop to a single round-trip per step.

---

## 3. Implementation of each action (exact commands)

Every command runs via `execInContainer(inst, ['bash','-lc', cmd], {user:'abc', timeout})`
with `DISPLAY=:1`. Coordinates are **scaled up** from API space to real
framebuffer pixels first (see §5.2). Define once:

```bash
export DISPLAY=:1
# X="$(real x)"  Y="$(real y)"  computed by the panel before substitution
```

| API action | Shell command (after coordinate scaling) |
|-------------|------------------------------------------|
| `mouse_move` | `xdotool mousemove --sync $X $Y` |
| `left_click` | `xdotool mousemove --sync $X $Y click 1` |
| `right_click` | `xdotool mousemove --sync $X $Y click 3` |
| `middle_click` | `xdotool mousemove --sync $X $Y click 2` |
| `double_click` | `xdotool mousemove --sync $X $Y click --repeat 2 --delay 120 1` |
| `triple_click` | `xdotool mousemove --sync $X $Y click --repeat 3 --delay 120 1` |
| `left_click` + `text` (modifiers) | `xdotool keydown $MODS mousemove --sync $X $Y click 1 keyup $MODS` |
| `left_click_drag` | `xdotool mousemove --sync $X1 $Y1 mousedown 1 mousemove --sync $X2 $Y2 mouseup 1` |
| `left_mouse_down` | `xdotool mousemove --sync $X $Y mousedown 1` |
| `left_mouse_up` | `xdotool mousemove --sync $X $Y mouseup 1` |
| `key` | `xdotool key --clearmodifiers -- "$KEYS"` (e.g. `ctrl+c`, `Return`, `alt+Tab`) |
| `hold_key` | `xdotool keydown -- "$KEYS"; sleep $DURATION; xdotool keyup -- "$KEYS"` |
| `type` (ASCII) | `xdotool type --clearmodifiers --delay 12 -- "$TEXT"` |
| `type` (Unicode/CJK) | clipboard paste — see §4 |
| `scroll` up | `xdotool mousemove --sync $X $Y click --repeat $N 4` |
| `scroll` down | `xdotool mousemove --sync $X $Y click --repeat $N 5` |
| `scroll` left | `xdotool mousemove --sync $X $Y click --repeat $N 6` |
| `scroll` right | `xdotool mousemove --sync $X $Y click --repeat $N 7` |
| `wait` | resolve after `duration` s in Node (no container call) |
| `cursor_position` | `xdotool getmouselocation --shell` → parse `X=`,`Y=`, then scale **down** to API space |
| `screenshot` | see §5 |

Notes:
- `--sync` makes `mousemove` block until the pointer actually arrives (avoids
  racing the click).
- `key`/`hold_key` `text` uses X keysym syntax (`ctrl+s`, `super`, `Return`,
  `Page_Down`). Pass through unchanged; quote with `--` to stop option parsing.
- `scroll_amount` maps to `--repeat N` of button 4/5/6/7. Default `N=3` if
  omitted.
- All user-supplied strings are passed as a **single argv element** (no shell
  interpolation) or `shlex`-quoted, never concatenated into a `bash -c` string,
  to prevent command injection (the text arrives from model output).

---

## 4. CJK / Unicode input strategy

`xdotool type` cannot reliably synthesize CJK (no keysym for most code points,
KasmVNC XKB limits) — this is the exact problem WOC already solved. Reuse the
established path:

**Decision rule:** if `text` is pure ASCII printable → `xdotool type`
(fast, no clipboard side effects). Otherwise → clipboard paste.

Clipboard paste (identical to existing `typeInInstance`), base64-framed to dodge
all shell-escaping issues:

```bash
export DISPLAY=:1
echo '<base64-of-utf8-text>' | base64 -d | xclip -selection clipboard -i
xdotool key --clearmodifiers ctrl+v
```

Considerations / refinements:
- **Restore clipboard?** Optional — save prior clipboard (`xclip -o`) and restore
  after paste so we don't clobber the user's clipboard. Default off (matches WOC).
- **Newlines:** `ctrl+v` pastes literal newlines; if a literal Enter is desired
  send a separate `key Return`.
- **Apps that block paste:** fall back to `xdotool key` with per-codepoint
  `U<hex>` keysyms (`xdotool key U4F60` for 你) — last resort, slower.
- The Node side decides ASCII-vs-clipboard; the agent just sends `type` + `text`.

---

## 5. Screenshot pipeline (capture → resize → encode → return)

### 5.1 Capture tool — Dockerfile change required

The instance image has no screenshot tool. Add ImageMagick (gives both capture
`import` and resize `convert`) to `images/wechat/Dockerfile`:

```dockerfile
apt-get install -y --no-install-recommends ... imagemagick
```

(Alternatives: `scrot` for capture + ImageMagick for resize, or `x11-apps`
`xwd` piped to `convert`. ImageMagick alone is the smallest single addition.)

### 5.2 Pipeline

Because `execInContainer` corrupts binary on stdout, **capture to a temp file
in the container, then read it back as bytes** with `readFileFromContainer`
(the same mechanism media export already uses):

```bash
# 1. read real geometry (cache per request)
xdotool getdisplaygeometry          # -> "1280 720"

# 2. capture + downscale + encode in one ImageMagick call
export DISPLAY=:1
import -window root -resize 1024x768 -quality 70 /tmp/cu-shot.jpg
#   -resize WxH  fits within box, preserving aspect ratio
#   -quality 70  good text legibility at small token cost
```

Then in Node:

```ts
await execInContainer(inst, ['bash','-lc', captureCmd], { user:'abc', timeout: 15000 });
const buf = await readFileFromContainer(inst, '/tmp/cu-shot.jpg');
const data = buf.toString('base64');
// width/height = the scaled target (read back via `identify` or computed)
```

### 5.3 Coordinate scaling (the core correctness detail)

KasmVNC geometry is dynamic, so we scale on every request, mirroring Anthropic's
reference `scale_coordinates`:

- Pick a **target** from `{XGA 1024×768, WXGA 1280×800, FWXGA 1366×768}` whose
  aspect ratio is closest to the real framebuffer; that target's width is the
  `display_width_px` advertised to the model (`/computer/display`).
- `x_factor = target_w / actual_w`, `y_factor = target_h / actual_h`.
- **API → COMPUTER** (incoming click): `realX = round(apiX / x_factor)`,
  `realY = round(apiY / y_factor)` — and reject out-of-bounds.
- **COMPUTER → API** (outgoing `cursor_position`, and the screenshot is resized
  to target): `apiX = round(realX * x_factor)`.
- Screenshots are resized to the target so the pixels Claude sees match the
  coordinate space it must click in.

Keep a single `scaleEnabled` flag; if the framebuffer already equals a target,
scaling is a no-op.

### 5.4 Token/perf knobs

- Default JPEG q70, fit-to-1024-wide → typically 40–120 KB → cheap in tokens.
- `?format=png` and `?quality=` overrides for debugging.
- `?settle_ms=` controls the post-action delay before capture (default 2000 ms;
  matches reference `_screenshot_delay`).

---

## 6. Integration: how a calling agent uses this

Two layers — we expose **both** and let the agent skill choose:

**A. Raw REST (what the panel implements).** One endpoint
`POST .../computer` that takes Anthropic-shaped action input and returns an
image block-shaped result. This is deliberately a 1:1 mirror of the tool I/O.

**B. Agent-side orchestration (the skill).** The skill running Claude owns the
*agent loop*; it does not need our server to call the Anthropic API:

```
1. GET  /computer/display            → build the `computer` tool definition
2. define tools=[computer(...)], betas=["computer-use-2025-01-24"]
3. loop:
   a. messages.create(...) → if stop_reason != tool_use: done
   b. for each tool_use block with name "computer":
        POST /computer  { ...tool_use.input, screenshot: true }
   c. append user message with tool_result:
        { tool_use_id, content: [ {type:text, text: output},
                                  {type:image, source:{type:base64,
                                     media_type:"image/jpeg", data: image.data}} ] }
   d. continue loop (cap at N iterations)
```

We deliberately **do not** implement the Anthropic API call server-side: it keeps
the panel a dumb, safe actuator (PAT-scoped, per-instance), avoids putting an
Anthropic key in the panel, and lets the existing skill/agent own model choice,
prompt-injection mitigations, and the human-in-the-loop confirmations Anthropic
recommends.

### 6.1 Example workflow — "click the search box and type 你好"

```jsonc
// 1. take a screenshot
POST /api/agent/instances/abc/computer
{ "action": "screenshot" }
// -> { ok:true, image:{ media_type:"image/jpeg", data:"...", width:1024, height:768 } }

// 2. agent (Claude) inspects the image, decides to click the search field
POST /api/agent/instances/abc/computer
{ "action": "left_click", "coordinate": [712, 96] }
// -> { ok:true, image:{...fresh screenshot...} }   (verify the field is focused)

// 3. type CJK text (panel auto-routes to clipboard paste)
POST /api/agent/instances/abc/computer
{ "action": "type", "text": "你好" }
// -> { ok:true, image:{...} }

// 4. press Enter
POST /api/agent/instances/abc/computer
{ "action": "key", "text": "Return" }
// -> { ok:true, image:{...} }   (agent confirms search results appeared)
```

Each step returns a screenshot so the agent can "evaluate the outcome before the
next step", per Anthropic's prompting guidance.

---

## 7. Implementation checklist

1. `images/wechat/Dockerfile`: add `imagemagick` to the apt install line.
2. New `images/panel/overlay/server/src/computer.ts`:
   - `getGeometry(inst)` → `{actual, scaled, factors}` (caches via `xdotool getdisplaygeometry`).
   - `runAction(inst, input)` → switch over actions, build argv, scale coords,
     ASCII-vs-clipboard for `type`, capture screenshot per policy.
   - `screenshot(inst, {quality,format,settleMs})` → capture-to-file + `readFileFromContainer` + base64.
   - `registerComputerRoutes(app, getUsers)` with `POST /computer`,
     `GET /computer/display`, `GET /computer/screenshot`, reusing `agentAuth` /
     `getInstanceOrFail` from `agent.ts` (export those or duplicate the small helpers).
3. `images/panel/Dockerfile`: add the `COPY images/panel/overlay/server/src/computer.ts ./src/computer.ts`
   line and patch `index.ts` to `registerComputerRoutes(app, listUsersRaw)`
   (same `sed` pattern already used for `registerAgentRoutes`).
4. Reuse `EXEC_TIMEOUT_MS`; add a `COMPUTER_TIMEOUT_MS` (~15 s) for screenshots.
5. Security: never string-concat model text into `bash -c`; pass argv elements or
   base64+`shlex`. Validate `coordinate` are non-negative ints within bounds.
   Keep computer use behind the same per-instance PAT scoping.
6. Optional: document the new endpoints in `docs/openapi.yaml` and the skill.
