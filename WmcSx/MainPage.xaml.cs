using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Threading.Tasks;
using Microsoft.UI.Xaml.Controls;
using Microsoft.Web.WebView2.Core;
using Windows.ApplicationModel;
using Windows.Data.Json;
using Windows.Media.Core;
using Windows.Media.Playback;
using Windows.Storage;
using Windows.Storage.Streams;
using Windows.System;
using Windows.System.Profile;
using Windows.UI.Core;
using Windows.UI.Xaml;
using Windows.UI.Xaml.Controls;
using Windows.UI.Xaml.Input;
using WmcSx.Services;

namespace WmcSx
{
    /// <summary>
    /// Hosts the interface (web\index.html in a WebView2) and connects it to the
    /// native features: DLNA, USB drives, background music and video playback.
    /// </summary>
    public sealed partial class MainPage : Page
    {
        public static MainPage Current;

        private const string AppHost = "app.wmcsx";
        private const string MediaHost = "https://media.wmcsx/";

        private WebView2 web;
        private bool creatingWeb;
        private bool inBackground;
        private readonly Player player = new Player();
        private readonly MediaPlayer video = new MediaPlayer();
        private bool videoOpen;
        private string videoKey;
        private double videoStart;
        private readonly DispatcherTimer tick = new DispatcherTimer();

        private readonly Dictionary<string, Tuple<byte[], string>> imageCache = new Dictionary<string, Tuple<byte[], string>>();
        private readonly LinkedList<string> imageOrder = new LinkedList<string>();

        public MainPage()
        {
            Log.Write("MainPage: constructor");
            InitializeComponent();
            Current = this;
            Log.Write("MainPage: layout loaded");

            try
            {
                Dlna.ServerFound += s => RunOnUi(() => PostEvent("server", s.ToJson()));
                player.Changed += () => RunOnUi(() => PostEvent("player", player.State()));

                tick.Interval = TimeSpan.FromSeconds(1);
                tick.Tick += (s, e) =>
                {
                    if (player.Music.PlaybackSession.PlaybackState == MediaPlaybackState.Playing)
                    {
                        PostEvent("player", player.State());
                    }
                };
                tick.Start();
                Log.Write("MainPage: music player ready");

                VideoView.SetMediaPlayer(video);
                video.MediaOpened += (s, e) =>
                {
                    if (videoStart > 5) s.PlaybackSession.Position = TimeSpan.FromSeconds(videoStart);
                };
                video.MediaEnded += (s, e) => RunOnUi(() => CloseVideo(true));
                video.MediaFailed += (s, e) =>
                {
                    Log.Write("Video failed: " + e.Error + " " + e.ErrorMessage);
                    RunOnUi(() =>
                    {
                        CloseVideo(false);
                        PostEvent("toast", J.S("That video couldn't be played. The format may not be supported."));
                    });
                };
                player.Music.MediaFailed += (s, e) => Log.Write("Music failed: " + e.Error + " " + e.ErrorMessage);
                Log.Write("MainPage: video player ready");

                SystemNavigationManager.GetForCurrentView().BackRequested += OnBackRequested;
                PreviewKeyDown += OnPreviewKeyDown;
            }
            catch (Exception ex)
            {
                Log.Error("MainPage setup", ex);
                ShowError(ex.Message);
            }

            Loaded += async (s, e) =>
            {
                Log.Write("MainPage: shown");
                try
                {
                    await CreateWebView();
                }
                catch (Exception ex)
                {
                    Log.Error("CreateWebView", ex);
                    ShowError(ex.Message);
                }
            };
        }

        public void ShowError(string message)
        {
            try
            {
                ShowStatus("WMC SX hit a problem.\n\n" + message + "\n\nDetails were saved to LocalState\\wmcsx_log.txt.");
            }
            catch
            {
            }
        }

        private void RunOnUi(Action action)
        {
            var ignored = Dispatcher.RunAsync(CoreDispatcherPriority.Normal, () => action());
        }

        // ---------------------------------------------------------------- WebView2

        private async Task CreateWebView()
        {
            if (web != null || creatingWeb) return;
            creatingWeb = true;
            try
            {
                StatusText.Visibility = Visibility.Collapsed;
                System.Environment.SetEnvironmentVariable("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", "--autoplay-policy=no-user-gesture-required");
                System.Environment.SetEnvironmentVariable("WEBVIEW2_DEFAULT_BACKGROUND_COLOR", "FF061C66");

                Log.Write("WebView2: creating");
                var view = new WebView2();
                view.HorizontalAlignment = HorizontalAlignment.Stretch;
                view.VerticalAlignment = VerticalAlignment.Stretch;
                WebHost.Children.Add(view);
                web = view;

                try
                {
                    Log.Write("WebView2: starting the browser engine");
                    await view.EnsureCoreWebView2Async();
                    Log.Write("WebView2: engine ready, version " + CoreWebView2Environment.GetAvailableBrowserVersionString());
                }
                catch (Exception ex)
                {
                    Log.Error("EnsureCoreWebView2Async", ex);
                    ShowStatus("WMC SX couldn't start its interface (WebView2 is missing or failed to load).\n\n" + ex.Message);
                    return;
                }

                var core = view.CoreWebView2;
                core.ProcessFailed += (s, e) => Log.Write("WebView2: browser process failed: " + e.ProcessFailedKind);
                core.NavigationCompleted += (s, e) => Log.Write("WebView2: page loaded, success=" + e.IsSuccess + " status=" + e.WebErrorStatus);
                core.Settings.AreDevToolsEnabled = false;
                core.Settings.AreDefaultContextMenusEnabled = false;
                core.Settings.IsZoomControlEnabled = false;
                core.Settings.IsStatusBarEnabled = false;

                string folder = Path.Combine(Package.Current.InstalledLocation.Path, "web");
                core.SetVirtualHostNameToFolderMapping(AppHost, folder, CoreWebView2HostResourceAccessKind.Allow);
                core.AddWebResourceRequestedFilter(MediaHost + "*", CoreWebView2WebResourceContext.All);
                core.WebResourceRequested += OnWebResourceRequested;
                core.WebMessageReceived += OnWebMessageReceived;
                core.NavigationCompleted += (s, e) => view.Focus(FocusState.Programmatic);
                core.Navigate("https://" + AppHost + "/index.html");
            }
            finally
            {
                creatingWeb = false;
            }
        }

        private void TearDownWeb()
        {
            if (web == null) return;
            var view = web;
            web = null;
            try
            {
                var core = view.CoreWebView2;
                if (core != null)
                {
                    try { core.MemoryUsageTargetLevel = CoreWebView2MemoryUsageTargetLevel.Low; } catch (Exception ex) { Log.Error("MemoryUsageTargetLevel", ex); }
                    try { core.Stop(); } catch { }
                }
                WebHost.Children.Clear();
                // Close() shuts down the browser engine and its processes. (Disposing the
                // control does nothing on WinUI 2, which is why memory stayed high before.)
                view.Close();
                Log.Write("WebView2: closed");
            }
            catch (Exception ex)
            {
                Log.Error("TearDownWeb", ex);
            }
            view = null;
        }

        private void ShowStatus(string text)
        {
            StatusText.Text = text;
            StatusText.Visibility = Visibility.Visible;
        }

        private void Post(JsonObject o)
        {
            if (web == null || web.CoreWebView2 == null) return;
            try
            {
                web.CoreWebView2.PostWebMessageAsJson(o.Stringify());
            }
            catch
            {
            }
        }

        private void PostEvent(string name, IJsonValue data)
        {
            var o = new JsonObject();
            o["event"] = J.S(name);
            o["data"] = data ?? JsonValue.CreateNullValue();
            Post(o);
        }

        // ---------------------------------------------------------------- Messages from the interface

        private async void OnWebMessageReceived(CoreWebView2 sender, CoreWebView2WebMessageReceivedEventArgs e)
        {
            JsonObject msg;
            try
            {
                msg = JsonObject.Parse(e.WebMessageAsJson);
            }
            catch
            {
                return;
            }

            var reply = new JsonObject();
            reply["id"] = J.N(J.Num(msg, "id", 0));
            try
            {
                IJsonValue argsValue;
                JsonObject args = msg.TryGetValue("args", out argsValue) && argsValue.ValueType == JsonValueType.Object
                    ? argsValue.GetObject()
                    : new JsonObject();
                var result = await Handle(J.Str(msg, "cmd", ""), args);
                reply["ok"] = J.B(true);
                reply["result"] = result ?? JsonValue.CreateNullValue();
            }
            catch (Exception ex)
            {
                reply["ok"] = J.B(false);
                reply["error"] = J.S(ex.Message);
            }
            Post(reply);
        }

        private async Task<IJsonValue> Handle(string cmd, JsonObject a)
        {
            switch (cmd)
            {
                case "info":
                {
                    var o = new JsonObject();
                    var v = Package.Current.Id.Version;
                    o["version"] = J.S(v.Major + "." + v.Minor + "." + v.Build);
                    o["device"] = J.S(AnalyticsInfo.VersionInfo.DeviceFamily);
                    return o;
                }
                case "discover":
                {
                    var ignored = DiscoverSafe(null);
                    return null;
                }
                case "probe":
                {
                    await DiscoverSafe(J.Str(a, "ip"));
                    return null;
                }
                case "connect":
                {
                    var arr = new JsonArray();
                    foreach (var s in await Dlna.LoadDescription(J.Str(a, "location", ""))) arr.Add(s.ToJson());
                    return arr;
                }
                case "servers":
                {
                    var arr = new JsonArray();
                    foreach (var s in Dlna.Servers) arr.Add(s.ToJson());
                    return arr;
                }
                case "browse":
                    return await Dlna.Browse(J.Str(a, "server"), J.Str(a, "id", "0"), (int)J.Num(a, "start", 0), (int)J.Num(a, "count", 200));
                case "usbList":
                    return await Usb.List(J.Str(a, "path"));
                case "usbScan":
                    return await Usb.Scan(J.Str(a, "path"), J.Str(a, "kind", "audio"), (int)J.Num(a, "max", 5000));
                case "play":
                    player.Play(J.Arr(a, "tracks"), (int)J.Num(a, "start", 0), J.Bool(a, "shuffle"));
                    return player.State();
                case "control":
                    player.Control(J.Str(a, "action", ""), J.Num(a, "value", 0));
                    return player.State();
                case "state":
                    return player.State();
                case "playVideo":
                    await OpenVideo(a);
                    return null;
                case "log":
                    Log.Write("Interface: " + J.Str(a, "text", ""));
                    return null;
                case "saveFile":
                {
                    var file = await ApplicationData.Current.LocalFolder.CreateFileAsync(SafeName(J.Str(a, "name")), CreationCollisionOption.ReplaceExisting);
                    await FileIO.WriteTextAsync(file, J.Str(a, "text", ""));
                    return null;
                }
                case "loadFile":
                {
                    var item = await ApplicationData.Current.LocalFolder.TryGetItemAsync(SafeName(J.Str(a, "name")));
                    var file = item as StorageFile;
                    if (file == null) return JsonValue.CreateNullValue();
                    return J.S(await FileIO.ReadTextAsync(file));
                }
            }
            throw new Exception("Unknown command: " + cmd);
        }

        private static async Task DiscoverSafe(string ip)
        {
            try
            {
                await Dlna.Discover(ip);
            }
            catch
            {
            }
        }

        private static string SafeName(string name)
        {
            name = name ?? "data";
            foreach (var c in Path.GetInvalidFileNameChars()) name = name.Replace(c, '_');
            return name.Length == 0 ? "data" : name;
        }

        // ---------------------------------------------------------------- Images for the interface

        private async void OnWebResourceRequested(CoreWebView2 sender, CoreWebView2WebResourceRequestedEventArgs args)
        {
            var deferral = args.GetDeferral();
            try
            {
                var uri = new Uri(args.Request.Uri);
                var query = ParseQuery(uri.Query);
                string path = uri.AbsolutePath;
                IRandomAccessStream stream = null;
                string type = "image/jpeg";

                if (path == "/img")
                {
                    string url;
                    if (query.TryGetValue("u", out url))
                    {
                        var data = await FetchImage(url);
                        if (data != null)
                        {
                            type = data.Item2;
                            stream = await ToStream(data.Item1);
                        }
                    }
                }
                else if (path == "/usbthumb")
                {
                    string p;
                    if (query.TryGetValue("p", out p)) stream = await Usb.Thumbnail(p, 320);
                }
                else if (path == "/usbfile")
                {
                    string p;
                    if (query.TryGetValue("p", out p))
                    {
                        stream = await Usb.Open(p);
                        type = MimeFromExtension(p);
                    }
                }

                if (stream != null)
                {
                    args.Response = sender.Environment.CreateWebResourceResponse(stream, 200, "OK",
                        "Content-Type: " + type + "\nCache-Control: max-age=86400\nAccess-Control-Allow-Origin: *");
                }
                else
                {
                    args.Response = sender.Environment.CreateWebResourceResponse(null, 404, "Not Found", "Access-Control-Allow-Origin: *");
                }
            }
            catch
            {
                try
                {
                    args.Response = sender.Environment.CreateWebResourceResponse(null, 404, "Not Found", "Access-Control-Allow-Origin: *");
                }
                catch
                {
                }
            }
            finally
            {
                deferral.Complete();
            }
        }

        private async Task<Tuple<byte[], string>> FetchImage(string url)
        {
            Tuple<byte[], string> hit;
            lock (imageCache)
            {
                if (imageCache.TryGetValue(url, out hit)) return hit;
            }

            var resp = await Dlna.Client.GetAsync(url);
            if (!resp.IsSuccessStatusCode) return null;
            var bytes = await resp.Content.ReadAsByteArrayAsync();
            string type = "image/jpeg";
            try
            {
                if (resp.Content.Headers.ContentType != null) type = resp.Content.Headers.ContentType.MediaType;
            }
            catch
            {
                // Unusual header from the server; JPEG is the safe guess for artwork.
            }
            var result = Tuple.Create(bytes, type);

            if (bytes.Length < 600 * 1024)
            {
                lock (imageCache)
                {
                    if (!imageCache.ContainsKey(url))
                    {
                        imageCache[url] = result;
                        imageOrder.AddLast(url);
                        while (imageOrder.Count > 300)
                        {
                            imageCache.Remove(imageOrder.First.Value);
                            imageOrder.RemoveFirst();
                        }
                    }
                }
            }
            return result;
        }

        private static async Task<IRandomAccessStream> ToStream(byte[] bytes)
        {
            var ms = new InMemoryRandomAccessStream();
            using (var writer = new DataWriter(ms.GetOutputStreamAt(0)))
            {
                writer.WriteBytes(bytes);
                await writer.StoreAsync();
                await writer.FlushAsync();
                writer.DetachStream();
            }
            ms.Seek(0);
            return ms;
        }

        private static Dictionary<string, string> ParseQuery(string query)
        {
            var d = new Dictionary<string, string>();
            foreach (var part in (query ?? "").TrimStart('?').Split('&'))
            {
                if (part.Length == 0) continue;
                int eq = part.IndexOf('=');
                string k = eq < 0 ? part : part.Substring(0, eq);
                string v = eq < 0 ? "" : part.Substring(eq + 1);
                d[Uri.UnescapeDataString(k.Replace('+', ' '))] = Uri.UnescapeDataString(v.Replace('+', ' '));
            }
            return d;
        }

        private static string MimeFromExtension(string path)
        {
            switch (Path.GetExtension(path).ToLowerInvariant())
            {
                case ".png": return "image/png";
                case ".gif": return "image/gif";
                case ".bmp": return "image/bmp";
                case ".webp": return "image/webp";
                default: return "image/jpeg";
            }
        }

        // ---------------------------------------------------------------- Video

        private async Task OpenVideo(JsonObject a)
        {
            string url = J.Str(a, "url", "");
            videoKey = J.Str(a, "key", url);
            videoStart = J.Num(a, "start", 0);

            MediaSource source;
            if (url.StartsWith("usb:")) source = MediaSource.CreateFromStorageFile(await Usb.GetFile(url.Substring(4)));
            else source = MediaSource.CreateFromUri(new Uri(url));

            var item = new MediaPlaybackItem(source);
            var props = item.GetDisplayProperties();
            props.Type = Windows.Media.MediaPlaybackType.Video;
            props.VideoProperties.Title = J.Str(a, "title", "");
            item.ApplyDisplayProperties(props);

            player.Pause();
            video.Source = item;
            videoOpen = true;
            VideoView.Visibility = Visibility.Visible;
            if (web != null) web.Visibility = Visibility.Collapsed;
            video.Play();
            VideoView.Focus(FocusState.Programmatic);
        }

        private void CloseVideo(bool ended)
        {
            if (!videoOpen) return;
            videoOpen = false;
            double pos = video.PlaybackSession.Position.TotalSeconds;
            double dur = video.PlaybackSession.NaturalDuration.TotalSeconds;
            video.Pause();
            video.Source = null;
            VideoView.Visibility = Visibility.Collapsed;
            if (web != null)
            {
                web.Visibility = Visibility.Visible;
                web.Focus(FocusState.Programmatic);
            }

            var o = new JsonObject();
            o["key"] = J.S(videoKey);
            o["position"] = J.N(ended ? 0 : pos);
            o["duration"] = J.N(dur);
            o["ended"] = J.B(ended);
            PostEvent("videoClosed", o);
        }

        // ---------------------------------------------------------------- Input and lifecycle

        private void OnBackRequested(object sender, BackRequestedEventArgs e)
        {
            e.Handled = true;
            if (videoOpen) CloseVideo(false);
            else PostEvent("back", null);
        }

        private void OnPreviewKeyDown(object sender, KeyRoutedEventArgs e)
        {
            if (videoOpen && (e.Key == VirtualKey.GamepadB || e.Key == VirtualKey.Escape))
            {
                CloseVideo(false);
                e.Handled = true;
            }
        }

        public static string MemoryText()
        {
            try
            {
                return (Windows.System.MemoryManager.AppMemoryUsage / 1048576) + " MB used of " +
                       (Windows.System.MemoryManager.AppMemoryUsageLimit / 1048576) + " MB allowed";
            }
            catch
            {
                return "memory unknown";
            }
        }

        private bool HasMusic()
        {
            var st = player.Music.PlaybackSession.PlaybackState;
            return player.Music.Source != null && st != MediaPlaybackState.None;
        }

        /// <summary>Frees everything that isn't needed for background music.</summary>
        /// <summary>Frees everything that isn't needed for background music, then waits for the memory to come back.</summary>
        public async Task ReduceMemoryAsync(string why)
        {
            Log.Write("Reducing memory (" + why + "): before " + MemoryText());
            if (videoOpen) CloseVideo(false);
            TearDownWeb();
            lock (imageCache)
            {
                imageCache.Clear();
                imageOrder.Clear();
            }
            // The browser engine's processes take a moment to exit after Close().
            for (int i = 0; i < 12; i++)
            {
                GC.Collect();
                GC.WaitForPendingFinalizers();
                GC.Collect();
                ulong used = Windows.System.MemoryManager.AppMemoryUsage;
                ulong limit = Windows.System.MemoryManager.AppMemoryUsageLimit;
                Log.Write("  after " + (i * 400) + " ms: " + MemoryText());
                if (used < 100UL * 1048576 && used < limit) break;
                await Task.Delay(400);
            }
            Log.Write("Reducing memory: done, " + MemoryText());
        }

        /// <summary>Called when the system is about to lower the memory limit.</summary>
        public async void OnMemoryLimitLowering(ulong newLimit)
        {
            if (HasMusic() && newLimit < 512UL * 1048576)
            {
                // Background music is about to be limited: unload the interface now.
                await ReduceMemoryAsync("limit lowering");
                // If it turned out to be brief and we're still on screen, bring the interface back.
                if (!inBackground && web == null && Windows.System.MemoryManager.AppMemoryUsageLimit >= 512UL * 1048576)
                {
                    Log.Write("Limit restored while visible, rebuilding the interface");
                    await CreateWebView();
                }
            }
            else
            {
                lock (imageCache) { imageCache.Clear(); imageOrder.Clear(); }
                GC.Collect();
                Log.Write("Limit lowering, cleared caches: " + MemoryText());
            }
        }

        public async Task OnEnteredBackgroundAsync()
        {
            inBackground = true;
            Log.Write("Entered background, music=" + HasMusic() + ", " + MemoryText());
            if (videoOpen) CloseVideo(false);
            // Xbox gives background apps very little memory (128 MB). Unload the interface
            // while music keeps playing; it's rebuilt when you come back.
            if (HasMusic() && web != null) await ReduceMemoryAsync("entered background with music");
        }

        public async void OnLeavingBackground()
        {
            inBackground = false;
            Log.Write("Leaving background, " + MemoryText());
            if (web == null) await CreateWebView();
            else PostEvent("player", player.State());
        }
    }
}
