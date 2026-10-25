using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using Windows.Data.Json;
using Windows.Media;
using Windows.Media.Core;
using Windows.Media.Playback;
using Windows.Storage.Streams;

namespace WmcSx.Services
{
    /// <summary>
    /// Music playback. Uses the system MediaPlayer, which keeps playing while the
    /// app is in the background and shows up in the Xbox guide's media controls.
    /// </summary>
    public sealed class Player
    {
        public readonly MediaPlayer Music = new MediaPlayer();
        private MediaPlaybackList list;
        private List<JsonObject> tracks = new List<JsonObject>();
        private string repeat = "off";

        public event Action Changed;

        public Player()
        {
            Music.AudioCategory = MediaPlayerAudioCategory.Media;
            Music.CommandManager.IsEnabled = true;
            Music.PlaybackSession.PlaybackStateChanged += (s, e) => Raise();
            Music.MediaFailed += (s, e) => Raise();
            Music.MediaEnded += (s, e) => Raise();
        }

        private void Raise()
        {
            var h = Changed;
            if (h != null) h();
        }

        public void Play(JsonArray queue, int start, bool shuffle)
        {
            if (queue.Count == 0) return;

            // Keep very large queues manageable: up to 1000 tracks around the chosen one.
            int from = 0;
            if (queue.Count > 1000)
            {
                from = Math.Max(0, Math.Min(start - 100, queue.Count - 1000));
            }
            int to = Math.Min(queue.Count, from + 1000);

            var newList = new MediaPlaybackList();
            var newTracks = new List<JsonObject>();
            for (int i = from; i < to; i++)
            {
                var t = queue.GetObjectAt((uint)i);
                var item = CreateItem(t);
                if (item == null) continue;
                newList.Items.Add(item);
                newTracks.Add(t);
            }
            if (newList.Items.Count == 0) return;

            int startIndex = Math.Max(0, Math.Min(start - from, newList.Items.Count - 1));
            newList.ShuffleEnabled = shuffle;
            newList.AutoRepeatEnabled = repeat == "all";
            newList.MaxPrefetchTime = TimeSpan.FromSeconds(10);
            newList.StartingItem = newList.Items[startIndex];
            newList.CurrentItemChanged += (s, e) => Raise();

            list = newList;
            tracks = newTracks;
            Music.Source = list;
            Music.Play();
            Raise();
        }

        private static MediaPlaybackItem CreateItem(JsonObject t)
        {
            string url = J.Str(t, "url");
            if (string.IsNullOrEmpty(url)) return null;

            MediaSource source;
            if (url.StartsWith("usb:"))
            {
                // Open USB files only when they're about to play.
                var binder = new MediaBinder();
                binder.Token = url.Substring(4);
                binder.Binding += async (b, args) =>
                {
                    var deferral = args.GetDeferral();
                    try
                    {
                        var file = await Usb.GetFile(b.Token);
                        args.SetStorageFile(file);
                    }
                    catch
                    {
                    }
                    deferral.Complete();
                };
                source = MediaSource.CreateFromMediaBinder(binder);
            }
            else
            {
                Uri uri;
                if (!Uri.TryCreate(url, UriKind.Absolute, out uri)) return null;
                source = MediaSource.CreateFromUri(uri);
            }

            var item = new MediaPlaybackItem(source);
            var props = item.GetDisplayProperties();
            props.Type = MediaPlaybackType.Music;
            props.MusicProperties.Title = J.Str(t, "title", "");
            props.MusicProperties.Artist = J.Str(t, "artist", "");
            props.MusicProperties.AlbumTitle = J.Str(t, "album", "");
            string art = J.Str(t, "art");
            Uri artUri;
            if (!string.IsNullOrEmpty(art) && art.StartsWith("http") && Uri.TryCreate(art, UriKind.Absolute, out artUri))
            {
                props.Thumbnail = RandomAccessStreamReference.CreateFromUri(artUri);
            }
            item.ApplyDisplayProperties(props);
            return item;
        }

        public void Control(string action, double value)
        {
            var session = Music.PlaybackSession;
            switch (action)
            {
                case "play": Music.Play(); break;
                case "pause": Music.Pause(); break;
                case "toggle":
                    if (session.PlaybackState == MediaPlaybackState.Playing) Music.Pause();
                    else Music.Play();
                    break;
                case "next":
                    if (list != null) list.MoveNext();
                    break;
                case "prev":
                    if (session.Position.TotalSeconds > 4 || list == null) session.Position = TimeSpan.Zero;
                    else list.MovePrevious();
                    break;
                case "seek":
                    session.Position = TimeSpan.FromSeconds(Math.Max(0, value));
                    break;
                case "skip":
                    session.Position = TimeSpan.FromSeconds(Math.Max(0, session.Position.TotalSeconds + value));
                    break;
                case "shuffle":
                    if (list != null) list.ShuffleEnabled = value > 0;
                    break;
                case "repeat":
                    repeat = value >= 2 ? "one" : value >= 1 ? "all" : "off";
                    Music.IsLoopingEnabled = repeat == "one";
                    if (list != null) list.AutoRepeatEnabled = repeat == "all";
                    break;
                case "stop":
                    Music.Pause();
                    Music.Source = null;
                    list = null;
                    tracks = new List<JsonObject>();
                    break;
            }
            Raise();
        }

        public void Pause()
        {
            Music.Pause();
        }

        public JsonObject State()
        {
            var o = new JsonObject();
            var session = Music.PlaybackSession;
            string state;
            switch (session.PlaybackState)
            {
                case MediaPlaybackState.Playing: state = "playing"; break;
                case MediaPlaybackState.Paused: state = "paused"; break;
                case MediaPlaybackState.Buffering:
                case MediaPlaybackState.Opening: state = "loading"; break;
                default: state = "stopped"; break;
            }
            if (list == null) state = "stopped";
            o["state"] = J.S(state);
            o["position"] = J.N(session.Position.TotalSeconds);
            o["duration"] = J.N(session.NaturalDuration.TotalSeconds);
            o["shuffle"] = J.B(list != null && list.ShuffleEnabled);
            o["repeat"] = J.S(repeat);
            o["count"] = J.N(tracks.Count);

            int index = CurrentIndex();
            o["index"] = J.N(index);
            if (index >= 0 && index < tracks.Count)
            {
                o["track"] = JsonObject.Parse(tracks[index].Stringify());
                var next = new JsonArray();
                foreach (var i in UpNext(index, 8)) next.Add(JsonObject.Parse(tracks[i].Stringify()));
                o["upNext"] = next;
            }
            return o;
        }

        private int CurrentIndex()
        {
            if (list == null) return -1;
            uint i = list.CurrentItemIndex;
            if (i == uint.MaxValue) return -1;
            return (int)i;
        }

        private IEnumerable<int> UpNext(int index, int max)
        {
            var result = new List<int>();
            if (list == null) return result;
            if (list.ShuffleEnabled)
            {
                var order = list.ShuffledItems.ToList();
                var current = list.Items[index];
                int pos = order.IndexOf(current);
                for (int k = 1; k <= max && pos >= 0 && pos + k < order.Count; k++)
                {
                    int real = list.Items.IndexOf(order[pos + k]);
                    if (real >= 0) result.Add(real);
                }
            }
            else
            {
                for (int k = index + 1; k < tracks.Count && result.Count < max; k++) result.Add(k);
            }
            return result;
        }
    }
}
