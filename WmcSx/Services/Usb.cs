using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using Windows.Data.Json;
using Windows.Storage;
using Windows.Storage.FileProperties;
using Windows.Storage.Search;
using Windows.Storage.Streams;

namespace WmcSx.Services
{
    /// <summary>Reads music, videos and photos from USB drives (including Windows-formatted iPods).</summary>
    public static class Usb
    {
        public static readonly string[] AudioTypes = { ".mp3", ".m4a", ".aac", ".flac", ".wav", ".wma", ".ogg", ".opus" };
        public static readonly string[] VideoTypes = { ".mp4", ".m4v", ".mkv", ".avi", ".wmv", ".mov", ".ts", ".webm" };
        public static readonly string[] ImageTypes = { ".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp", ".heic", ".heif" };

        private static readonly Dictionary<string, IStorageItem> cache = new Dictionary<string, IStorageItem>(StringComparer.OrdinalIgnoreCase);

        public static string KindOf(string name)
        {
            string ext = System.IO.Path.GetExtension(name ?? "").ToLowerInvariant();
            if (AudioTypes.Contains(ext)) return "audio";
            if (VideoTypes.Contains(ext)) return "video";
            if (ImageTypes.Contains(ext)) return "image";
            return null;
        }

        private static void Remember(IStorageItem item)
        {
            lock (cache) cache[item.Path] = item;
        }

        public static async Task<StorageFolder> GetFolder(string path)
        {
            IStorageItem item;
            lock (cache) cache.TryGetValue(path, out item);
            var folder = item as StorageFolder;
            if (folder != null) return folder;
            folder = await StorageFolder.GetFolderFromPathAsync(path);
            Remember(folder);
            return folder;
        }

        public static async Task<StorageFile> GetFile(string path)
        {
            IStorageItem item;
            lock (cache) cache.TryGetValue(path, out item);
            var file = item as StorageFile;
            if (file != null) return file;
            file = await StorageFile.GetFileFromPathAsync(path);
            Remember(file);
            return file;
        }

        /// <summary>Lists connected drives, or the contents of one folder.</summary>
        public static async Task<JsonArray> List(string path)
        {
            var arr = new JsonArray();
            if (string.IsNullOrEmpty(path))
            {
                var drives = await KnownFolders.RemovableDevices.GetFoldersAsync();
                foreach (var d in drives)
                {
                    Remember(d);
                    var o = new JsonObject();
                    o["kind"] = J.S("container");
                    o["id"] = J.S(d.Path);
                    o["title"] = J.S(string.IsNullOrWhiteSpace(d.DisplayName) ? d.Name : d.DisplayName);
                    o["drive"] = J.B(true);
                    arr.Add(o);
                }
                return arr;
            }

            var folder = await GetFolder(path);
            var folders = await folder.GetFoldersAsync();
            foreach (var f in folders.OrderBy(x => x.Name, StringComparer.CurrentCultureIgnoreCase))
            {
                Remember(f);
                var o = new JsonObject();
                o["kind"] = J.S("container");
                o["id"] = J.S(f.Path);
                o["title"] = J.S(f.Name);
                arr.Add(o);
            }

            var files = await folder.GetFilesAsync();
            int tagged = 0;
            foreach (var file in files.OrderBy(x => x.Name, StringComparer.CurrentCultureIgnoreCase))
            {
                string kind = KindOf(file.Name);
                if (kind == null) continue;
                Remember(file);
                // Reading tags is slow on big folders; tag the first few hundred.
                arr.Add(await Describe(file, kind, tagged++ < 400));
            }
            return arr;
        }

        /// <summary>Finds every file of one kind on a drive, searching all folders.</summary>
        public static async Task<JsonArray> Scan(string path, string kind, int max)
        {
            var arr = new JsonArray();
            var folder = await GetFolder(path);
            string[] types = kind == "audio" ? AudioTypes : kind == "video" ? VideoTypes : ImageTypes;
            var options = new QueryOptions(CommonFileQuery.DefaultQuery, types);
            options.FolderDepth = FolderDepth.Deep;
            options.IndexerOption = IndexerOption.DoNotUseIndexer;
            var query = folder.CreateFileQueryWithOptions(options);

            uint index = 0;
            const uint page = 200;
            while (arr.Count < max)
            {
                var batch = await query.GetFilesAsync(index, page);
                if (batch.Count == 0) break;
                foreach (var file in batch)
                {
                    Remember(file);
                    arr.Add(await Describe(file, kind, kind == "audio"));
                    if (arr.Count >= max) break;
                }
                index += (uint)batch.Count;
            }
            return arr;
        }

        private static async Task<JsonObject> Describe(StorageFile file, string kind, bool readTags)
        {
            var o = new JsonObject();
            o["kind"] = J.S(kind);
            o["id"] = J.S(file.Path);
            o["url"] = J.S("usb:" + file.Path);
            o["title"] = J.S(System.IO.Path.GetFileNameWithoutExtension(file.Name));
            o["usb"] = J.B(true);
            if (kind == "audio" && readTags)
            {
                try
                {
                    MusicProperties m = await file.Properties.GetMusicPropertiesAsync();
                    if (!string.IsNullOrWhiteSpace(m.Title)) o["title"] = J.S(m.Title);
                    string artist = !string.IsNullOrWhiteSpace(m.Artist) ? m.Artist : m.AlbumArtist;
                    if (!string.IsNullOrWhiteSpace(artist)) o["artist"] = J.S(artist);
                    if (!string.IsNullOrWhiteSpace(m.Album)) o["album"] = J.S(m.Album);
                    if (m.Genre != null && m.Genre.Count > 0) o["genre"] = J.S(m.Genre[0]);
                    if (m.TrackNumber > 0) o["track"] = J.N(m.TrackNumber);
                    if (m.Duration.TotalSeconds > 0) o["duration"] = J.N(m.Duration.TotalSeconds);
                }
                catch
                {
                    // Untagged or unreadable file; keep the filename.
                }
            }
            o["art"] = J.S("usbthumb:" + file.Path);
            return o;
        }

        /// <summary>A small picture for a file (album art, video frame or photo thumbnail).</summary>
        public static async Task<IRandomAccessStream> Thumbnail(string path, uint size)
        {
            var file = await GetFile(path);
            string kind = KindOf(file.Name);
            var mode = kind == "audio" ? ThumbnailMode.MusicView : kind == "video" ? ThumbnailMode.VideosView : ThumbnailMode.PicturesView;
            var thumb = await file.GetThumbnailAsync(mode, size, ThumbnailOptions.UseCurrentScale);
            if (thumb == null || thumb.Size == 0) return null;
            return thumb;
        }

        public static async Task<IRandomAccessStream> Open(string path)
        {
            var file = await GetFile(path);
            return await file.OpenReadAsync();
        }

        public static async Task<byte[]> ReadAll(string path)
        {
            var file = await GetFile(path);
            var buffer = await FileIO.ReadBufferAsync(file);
            var bytes = new byte[buffer.Length];
            using (var reader = DataReader.FromBuffer(buffer)) reader.ReadBytes(bytes);
            return bytes;
        }
    }
}
