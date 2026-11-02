# WMC SX: notes for working on this app

A media center app for Xbox Series X|S (UWP). Plays music, videos and photos from a DLNA media server on the home network (for example a Synology NAS) and from USB drives. Published free on the Microsoft Store and also installed in Dev Mode for testing.

Don't put real IP addresses, device or NAS names, or other home-network details in this repo, screenshots or commit messages. Use made-up examples like 192.168.1.20 and "Home NAS". The repo is public.

## How it's built

- **App:** C# UWP (.NET Native, C# 7.3), Microsoft.NETCore.UniversalWindowsPlatform 6.2.14.
- **Interface:** HTML/CSS/JS in `WmcSx/web` (`index.html`, `app.css`, `app.js`). It's shown in a WinUI 2 WebView2 (Microsoft.UI.Xaml 2.8.7).
  - The explicit **Microsoft.Web.WebView2 1.0.4078.44** reference is required. Without it, Xbox reports "WebView2 runtime not detected".
- **Hosting:** the interface is served from `https://app.wmcsx/` through a virtual host mapping.
- **Images:** go through a `WebResourceRequested` proxy in `MainPage.xaml.cs`:
  - `https://media.wmcsx/img?u=<url>&s=<size>` serves tiles and artwork. They're shrunk to `size` and saved in LocalCache\thumbs.
  - `https://full.wmcsx/img?u=<url>` serves full-size photos. It's a separate host so full photos never queue behind tiles, because Chromium limits requests per host.
  - `/usbthumb?p=` and `/usbfile?p=` serve USB files.
  - `https://full.wmcsx/audio?u=<url>` serves a whole song (max 60 MB, one at a time) for the music visualizer.
- **JS ↔ C# bridge:** `Bridge.call(cmd, args)` → `MainPage.Handle(cmd)`. C# sends events back with `PostEvent` (`server`, `player`, `toast`, `videoClosed`, `back`, `active`).
- **`web/mock.js`:** fakes the C# side so the interface runs in a normal browser.
  - Serve the folder with `python3 -m http.server`, then use Playwright for screenshots.
  - Store screenshots come from this mock (`store-assets/`). The mock paints sample photos/album art/video frames (`photo()`), has a 30,214-photo dated folder and a synthetic drum loop. `window.WmcDebug` (preview only) exposes `Viz`, `Beats`, `Mixes`, `History`.
- **Services:**
  - `Dlna.cs`: SSDP discovery and ContentDirectory browse. Synology quotes its charset, so responses are decoded as UTF-8 by hand.
  - `Usb.cs`: USB drives.
  - `Player.cs`: background music through MediaPlaybackList.
  - `HttpRangeStream.cs`: video range reading. It's currently off (`UseRangeReading = false`).
  - `Log.cs`, `J.cs`: logging and JSON helpers.

## Build, test, publish

- **Building:** pushing to `main` runs `.github/workflows/build.yml`. The version is `1.0.<run number>.0`.
  - Job **build** makes a sideload package, artifact `WMC-SX-<ver>-install`, for Dev Mode. Install it via the Xbox Device Portal (Add, then tick the optional dependency .appx files).
  - Job **store** makes the Store package (`.msixupload`) and force-pushes it to the `store-upload` branch as `WMC-SX.msixupload` plus `VERSION.txt`.
  - C# can't be compiled in the Claude cloud workspace (NuGet is blocked), so CI is the compile check. `gh run watch` works for waiting on it.
- **Store (Partner Center):** Store ID 9N8KNK9J4BK4, identity `44468veggielasagna.WMCSX`. The workflow swaps in the Store identity.
  - The owner signs in to Partner Center in the built-in browser. Sign-ins expire often.
  - Start update → Packages. In page JS, fetch `https://raw.githubusercontent.com/veggielasagna/wmc_sx/store-upload/WMC-SX.msixupload`, put it on the `input[type=file]` with a DataTransfer, wait for validation, then Save.
  - Each Store screenshot card has its own hidden file input that replaces that image.
  - Always ask the owner before pressing **Submit for certification**.
- **Logs:**
  - On Xbox, the log is `LocalState\wmcsx_log.txt` (plus `_previous`).
  - In Dev Mode, download it from the Device Portal's file explorer.
  - In retail mode, open it in the app under Settings › About › Show log (newest first). The owner photographs the screen.
  - After a crash, the app restarts with a new log; **Last time’s log** on the same screen shows `_previous` (what happened before the crash).
  - The log box takes focus when it opens; up/down scroll inside it (any element with `data-scroll` works this way), and moving past either end leaves it.

## Xbox lessons learned

- **Memory:** the background limit is 128 MB. WebView2 must be closed with `view.Close()` (Dispose doesn't free it) when the app goes to the background, so music keeps playing.
  - Dev Mode "Game" apps (emulators like XBSX2) suspend other apps. That's outside the app's control.
- **Retail vs Dev Mode:** retail mode gives apps far less memory than Dev Mode (5 GB there). Always think about memory for anything that decodes images.
- **HEIC photos:** Synology serves iPhone HEIC photos as `application/octet-stream` with no JPEG copy or thumbnail.
  - The app converts them with BitmapDecoder. Tiles use the preview embedded inside each photo; full photos are decoded only when there's enough memory.
  - Conversions run at most 2 at a time for tiles and 1 for the full photo.
  - iOS 18 photos (24 MP with an HDR `tmap` gain-map item) are retried with that item hidden if decoding fails.
- **Tile pictures in big folders (Chromium picture cache):** the browser engine keeps every picture it has shown, whether a CSS background or an `<img>`, even after it's removed, and only lets go under memory pressure, which it never detects on Xbox. Scrolling a folder of 800+ photos ran the app out of memory ("This page is having a problem · Out of Memory"). Measured in the browser preview with 1,000 photos: about 0.5 MB kept per photo, regardless of Cache-Control headers or blob URLs.
  - Fix (1.0.22): list and grid pictures are drawn into a `<canvas>` (`lazyArt` / `showArt` / `hideArt` / `watchArt` in `app.js`): fetch, `createImageBitmap`, draw, `close()`. The canvas is emptied when the item scrolls more than 600 px out of view. Memory stays flat (about 400 MB vs 730+ MB). Use `lazyArt` for anything that can repeat in a long list.
  - Safety nets in `MainPage.xaml.cs`: above 70% of the memory limit (or at memory level High), `FreeBrowserMemory` briefly sets `MemoryUsageTargetLevel = Low`, which makes the engine drop its caches. If the render process still dies, `OnProcessFailed` reloads `index.html?recovered=1` (at most once a minute), and the interface returns to the same screen with a toast.
  - Still uses plain `<img>`: the photo viewer (full-size photos) and single artwork (Now Playing, album header). Those are covered by the safety nets.
  - The log notes `Pictures made: N, <memory>` every 100 tiles, so memory growth shows up in the log.
- **Controller input:** ignore it while the app isn't active (the guide or another app is on top). The C# side sends an `active` event.
- **Focus jumping after closing a video:** focus jumped a tile or two left/right right after backing out of a video, with nobody touching the controller.
  - Two causes. (1) The engine sends a d-pad keydown (203–206) as the interface comes back; `settleInput()` ignores direction input for 1 s after `videoClosed` (350 ms after `active`), and a key repeat only counts if its first press was seen. (2, the visible flick) Chromium sends a synthetic `mousemove` at its last pointer position when the page changes under it; on Xbox that invisible pointer sits over some tile, which took the focus. The `mousemove` handler now ignores events where the pointer didn't actually move, and any pointer focus during the settle time. Replayed in the preview: old code jumped item 4 → 1 on a stale pointer event, new code stays.
  - Diagnostics: for 4 s after a video closes, every focus change is logged with its cause (`input: focus item 4 -> item 1 (pointer at …)`), C# logs `Video: closed` and every key the console delivers for 2 s (`Console key GamepadDPadLeft …`), so a stray press can be traced to the controller or the engine.
- **Big folders:** `Lib.browsePages` reads folders in pages of 500 with no 5,000 cap. `folderLoader` shows the first ~400 items, then streams the rest into the same collection (and the photo viewer's list) while the screen stays open. The live count is `#folderCount`.
- **Navigation speed:** focus scrolling uses `bringIntoView()` (a 110 ms glide), not `scrollIntoView({behavior:'smooth'})`, which lagged behind held presses. `nearest()` looks only at on-screen items first.
- **Videos:** d-pad left/right in the player sends `videoStep`; JS plays the previous/next item of `videoList`. When switching, C# posts `videoClosed` with `switched: true` for the old video (so Continue watching keeps its spot) and the interface stays hidden.
- **Music visualizer:** Y on Now Playing (`Viz` in `app.js`). The native player's audio can't be tapped from the page, so `Beats` fetches the song via `/audio`, decodes it at 11 kHz with OfflineAudioContext, and maps bass/mid/treble at 60 fps plus beat times; the visuals follow the player position.
  - Rendering is video feedback (Milkdrop-style), two WebGL passes per frame: `VIZ_FEED` draws the last frame zoomed/rotated/warped/hue-shifted with a decay, then paints new shapes with `max()` (no white-out); `VIZ_SHOW` puts it on screen with bass-driven colour fringes. Ping-pong RGBA textures at canvas size.
  - Styles: Kaleidoscope (trails fed back through the mirrors), Tunnel (zooms *out* so rings shrink toward the centre; zooming in on trails blurs them), Liquid (curl-noise flow), Fractal (kali set), Starfield (fast zoom streaks stars; beats jump forward), Ribbons (three waves driven by bass/mid/treble, trails drift up), Album Colors (clouds in three colours taken from the album art by `artColors()`: hue buckets weighted by saturation × brightness, saturation boosted; no hue drift). Per-style tables in `frame()` (zoom, decay, sharpen, source, spin, warp); slow drifts need low `sharp` or the trails ring into stripes. Beats drive motion, not brightness (`onBeat`: zoom punch, spin shove, hue turn; spin flips every 8 beats, kaleidoscope mirror count changes every 16). Songs over 15 min or 60 MB, or formats Chromium can't decode (ALAC, WMA), get the gentle no-beat mode. Resolution adapts to frame time (starts at 1280×720, up to 1920×1080, down to 320×180); each feedback pass applies a light unsharp mask (`px` texel size) so repeated zoomed copies don't blur. On close the GL context is lost to free memory and `#vizCanvas` is replaced with a new canvas (`release()`/`freshCanvas()`): a canvas whose context was lost with WEBGL_lose_context never gives a working context again, which made 1.0.27 show "This console can't draw the visualizer" on every open after the first. A `webglcontextlost` during play (console reclaiming GPU memory) restarts on a fresh canvas.
- **Screensaver:** `checkVizIdle()` closes the screensaver a minute after the music stops, and stops keeping the TV awake 5 minutes after it stops under a manually opened visualizer. `checkSaver()` opens the visualizer (`Viz.show({ saver: true })`) after `prefs.saverMin` minutes of music with no input; any button closes it and does nothing else. Visualizer and slideshows call `keepAwake` (native `DisplayRequest`) so the TV doesn't dim.
- **Mixes and play history:** a song counts as played after 30 s (or half a short song); counts and last-played are in `plays.json` (via `saveFile`). `Mixes.build(key)`: `all`, `rediscover` (played but not for 30+ days, most-played first, topped up with never-played, 100 songs), `most`, `a:<artist>`, `g:<genre>`.
- **Slideshows:** Ken Burns via CSS (`.vimg.kb`, random `--kx/--ky/--ks` per photo), 1.6 s crossfades. `prefs.slideMusic` picks a mix when nothing is playing; music the slideshow started pauses when the viewer closes.
- **Video thumbnails:** NAS videos without a poster use `vthumb:<url>` → `frame.wmcsx/vthumb` (its own host, so seconds-long grabs never queue album art or photo tiles behind them) → `FetchVideoFrame`. `framesPaused` (set by OpenVideo, cleared by CloseVideo) stops a grab mid-way so it never decodes alongside your video; at most 6 requests wait (abandoned ones can't be cancelled); files that can't seek take a frame after ~1.5 s of play. Details: hidden muted MediaPlayer with frame server, seek ~15 % in, `CopyFrameToVideoSurface` into a `VideoFrame.CreateAsDirect3D11SurfaceBacked` surface, JPEG, saved in LocalCache\thumbs. One at a time, skipped while a video plays or in the background; failures not retried until relaunch. Rotation metadata on phone videos is untested.
- **Photo timeline:** photo folders with 40+ dated photos get All photos / By month (`Store 'photoView'`). Months from `dc:date`; `PhotoCache` keeps the last two folders' items so switching or opening a month (`photoMonth` route) doesn't re-read the NAS.
- **Menu sounds:** silent while music is playing (`Sfx.play`); C# also sets `ElementSoundPlayer.State` Off while music plays.
- **Look:** warm Aero (1.0.23+): ember-dusk backdrop with light streaks, smoked-bronze glass with a top-half gloss and inner edge, amber selected glass, honey-gold focus glow. No `filter: blur` or `backdrop-filter` on animated layers; they're expensive on the Xbox GPU. Store screenshots and art in `store-assets/` (8 screenshots, box art, poster) are in Ember, made from the mock.
- **Color themes (Settings › Colors):** every colour in `app.css` is a variable `--t0…--tN` holding the Ember values (`:root` at the top). `Theme` in `app.js` reads those once and, for another theme, turns them around the colour wheel and scales saturation/lightness (`THEMES`: hue/sat/light), so glass, gloss, glows and text keep their relationships. New CSS colours should be added as `--t` variables too (white/black glosses and the controller button colours `.hb.*` stay fixed). Placeholder tile gradients (`GRADS`) and the background ribbons follow the theme. The theme's background colour is saved natively (`theme` command → LocalSettings `background`) so the app's first frame matches. The visualizer, album art, photos and videos are unaffected.
- **Thumbnail bug (fixed):** in `style="…"` attributes, background URLs must use single quotes. A double quote ended the attribute and broke every thumbnail.

## Open issues

- **Slow video start:** videos take about 30 s to start, even plain H.264/AAC .mov files. The network is not the bottleneck: the whole file index arrives in milliseconds. The wait happens inside the Xbox's MediaPlayer, which looks like a timeout.
  - Next step: log timestamps for each stage (MediaSource open, item tracks, PlaybackSession state changes) to find which step stalls.
  - Also check whether .mp4 files and short iPhone clips are just as slow.
- **Garbled song titles:** some titles appear as garbled CJK characters. They come from the NAS's index of the file's tags, not from the app.
