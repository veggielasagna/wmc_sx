# WMC SX

A media player for Xbox Series X|S in Dev Mode, styled after classic Media Center with a Frutiger Aero look. It plays music, videos and photos from your NAS (DLNA, no login) and from USB drives. Music keeps playing in the background while you use other Dev Mode apps, such as xemu through Game Vault.

## What's in here

| Path | What it is |
|---|---|
| `WmcSx/web/` | The interface: `index.html`, `app.css`, `app.js`. `mock.js` lets you open `index.html` in a normal browser to try it out with fake data. |
| `WmcSx/MainPage.xaml.cs` | The native host. It shows the interface in a WebView2 and links it to the native features below. |
| `WmcSx/Services/Dlna.cs` | Finds DLNA media servers on your network and browses them. |
| `WmcSx/Services/Usb.cs` | Reads USB drives and Windows-formatted iPods. |
| `WmcSx/Services/Player.cs` | Background music playback, including the Xbox guide's media controls. |
| `.github/workflows/build.yml` | Builds and signs the app on GitHub's Windows machines, so you don't need a Windows PC. |

## Build it (no Windows PC needed)

1. Create a new **private** repository on GitHub, for example `wmc-sx`.
2. Upload everything in this folder to it, including the hidden `.github` folder.
3. Open the repository's **Actions** tab. The "Build WMC SX" run starts by itself after each upload. You can also start it with **Run workflow**.
4. When the run is green (about 10 minutes), open it and download **WMC-SX-…-install** under *Artifacts*. Unzip it.

## Install on the Xbox

1. On your computer, open the Xbox Device Portal, at the address shown in Dev Home (for example `https://<xbox-ip>:11443`).
2. On **Home**, choose **Add**.
3. Choose the `WmcSx_…_x64.msix` file as the app package, then **Next**.
4. Tick **I want to specify optional packages**, add every `.appx` file from the same folder, then **Start**.
5. WMC SX shows up in Dev Home. To update later, install a newer build the same way. Your settings and library are kept.

## Controller

| Button | Action |
|---|---|
| A | Select |
| B | Back |
| X | Play / pause music |
| Y | Search |
| LB / RB | Previous / next song |
| LT / RT | Back 10 s / ahead 30 s |
| Menu | Now Playing |
| View | Home |

## Notes

- **NAS:** WMC SX finds DLNA servers automatically, and on a Synology that's the *Media Server* package. If your NAS doesn't show up, enter its IP address under Settings › Sources.
- **Library:** On first connect, WMC SX scans the server's folder view to build its own search index. This takes a minute or two for large libraries and refreshes daily.
- **USB:** Drives must be exFAT, FAT32 or NTFS. iPods need to be Windows-formatted. Use *All music on this drive* on an iPod to see songs by their tags instead of the scrambled filenames.
- **Background music:** It keeps playing while you're in other Dev Mode apps. Xbox gives background apps very little memory, so WMC SX unloads its interface while in the background and redraws it when you come back.
