using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Runtime.InteropServices.WindowsRuntime;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Windows.Foundation;
using Windows.Storage.Streams;

namespace WmcSx.Services
{
    /// <summary>
    /// Reads a video from the media server in byte ranges. Before playback starts, the file's index
    /// (the "moov" box, at the end of most .mov files from Macs and capture cards) is downloaded in one
    /// request and kept in memory, so the player doesn't have to hunt for it over the network.
    /// </summary>
    public sealed class HttpRangeStream : IRandomAccessStream
    {
        private static readonly HttpClient Http = CreateHttp();

        /// <summary>What every copy of the stream shares: the file, the parts kept in memory, and counters for the log.</summary>
        private sealed class Shared
        {
            public Uri Uri;
            public ulong Size;
            public string ContentType;
            public readonly List<KeyValuePair<ulong, byte[]>> Pinned = new List<KeyValuePair<ulong, byte[]>>();
            public int Requests;
            public long Bytes;
            public long MemoryHits;
            public readonly StringBuilder Trace = new StringBuilder();
            private int traced;

            public void Note(string s)
            {
                lock (this)
                {
                    if (traced++ < 30) Trace.Append(s).Append("; ");
                }
            }
        }

        private readonly Shared shared;
        private readonly SemaphoreSlim gate = new SemaphoreSlim(1, 1);
        private ulong position;
        private HttpResponseMessage response;
        private Stream body;
        private ulong bodyPos;
        private bool disposed;

        public string ContentType { get { return shared.ContentType; } }
        public string Layout { get; private set; }

        private static HttpClient CreateHttp()
        {
            var c = new HttpClient();
            c.Timeout = Timeout.InfiniteTimeSpan;
            c.DefaultRequestHeaders.TryAddWithoutValidation("User-Agent", "WMCSX/1.0 UPnP/1.1 DLNADOC/1.50");
            return c;
        }

        private HttpRangeStream(Shared shared)
        {
            this.shared = shared;
        }

        public string Stats()
        {
            return shared.Requests + " requests, " + (shared.Bytes / 1024) + " KB from network, " + shared.MemoryHits + " reads from memory. Opens: " + shared.Trace;
        }

        /// <summary>Returns null when the server doesn't support byte ranges.</summary>
        public static async Task<HttpRangeStream> TryOpen(Uri uri, TimeSpan timeout)
        {
            Shared s;
            using (var cts = new CancellationTokenSource(timeout))
            {
                var req = new HttpRequestMessage(HttpMethod.Get, uri);
                req.Headers.Range = new RangeHeaderValue(0, 0);
                using (var r = await Http.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, cts.Token))
                {
                    if (r.StatusCode != HttpStatusCode.PartialContent) return null;
                    var range = r.Content.Headers.ContentRange;
                    if (range == null || !range.HasLength || range.Length.Value <= 0) return null;
                    string type = null;
                    try
                    {
                        if (r.Content.Headers.ContentType != null) type = r.Content.Headers.ContentType.MediaType;
                    }
                    catch
                    {
                        // Unusual Content-Type header; the caller supplies a type instead.
                    }
                    s = new Shared { Uri = uri, Size = (ulong)range.Length.Value, ContentType = type };
                }
            }

            var stream = new HttpRangeStream(s);
            try
            {
                stream.Layout = await PinIndex(s);
            }
            catch (Exception ex)
            {
                stream.Layout = "couldn't read the layout: " + ex.Message;
            }
            return stream;
        }

        /// <summary>Walks the top-level boxes of an MP4/MOV file and keeps the start of the file and its index in memory.</summary>
        private static async Task<string> PinIndex(Shared s)
        {
            var sb = new StringBuilder();
            using (var cts = new CancellationTokenSource(TimeSpan.FromSeconds(20)))
            {
                var head = await GetRange(s, 0, Math.Min(256UL * 1024, s.Size), cts.Token);
                s.Pinned.Add(new KeyValuePair<ulong, byte[]>(0, head));

                ulong pos = 0;
                for (int i = 0; i < 24 && pos + 8 <= s.Size; i++)
                {
                    byte[] h = pos + 16 <= (ulong)head.Length ? Slice(head, (int)pos, 16) : await GetRange(s, pos, Math.Min(16UL, s.Size - pos), cts.Token);
                    if (h.Length < 8) break;
                    ulong len = BE32(h, 0);
                    ulong hdr = 8;
                    string type = Encoding.ASCII.GetString(h, 4, 4);
                    if (!IsBoxName(type)) break;
                    if (len == 1)
                    {
                        if (h.Length < 16) break;
                        len = BE64(h, 8);
                        hdr = 16;
                    }
                    else if (len == 0)
                    {
                        len = s.Size - pos;
                    }
                    if (len < hdr || pos + len > s.Size) break;
                    sb.Append(type).Append(" at ").Append(pos / 1048576).Append(" MB (").Append(len < 1048576 ? (len / 1024) + " KB" : (len / 1048576) + " MB").Append("), ");

                    if (type == "moov" && len <= 96UL * 1048576 && pos + len > (ulong)head.Length)
                    {
                        var sw = Stopwatch.StartNew();
                        var moov = await GetRange(s, pos, len, cts.Token);
                        s.Pinned.Add(new KeyValuePair<ulong, byte[]>(pos, moov));
                        sb.Append("[index loaded in ").Append(sw.ElapsedMilliseconds).Append(" ms] ");
                    }
                    pos += len;
                }
            }
            return sb.Length > 0 ? sb.ToString() : "not an MP4/MOV layout";
        }

        private static bool IsBoxName(string t)
        {
            foreach (char c in t) if (c < 0x20 || c > 0x7E) return false;
            return true;
        }

        private static ulong BE32(byte[] b, int o)
        {
            return ((ulong)b[o] << 24) | ((ulong)b[o + 1] << 16) | ((ulong)b[o + 2] << 8) | b[o + 3];
        }

        private static ulong BE64(byte[] b, int o)
        {
            return (BE32(b, o) << 32) | BE32(b, o + 4);
        }

        private static byte[] Slice(byte[] b, int o, int n)
        {
            var r = new byte[n];
            Array.Copy(b, o, r, 0, n);
            return r;
        }

        private static async Task<byte[]> GetRange(Shared s, ulong start, ulong length, CancellationToken ct)
        {
            var req = new HttpRequestMessage(HttpMethod.Get, s.Uri);
            req.Headers.Range = new RangeHeaderValue((long)start, (long)(start + length - 1));
            Interlocked.Increment(ref s.Requests);
            using (var r = await Http.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, ct))
            {
                if (r.StatusCode != HttpStatusCode.PartialContent) throw new IOException("range not returned (" + (int)r.StatusCode + ")");
                using (var body = await r.Content.ReadAsStreamAsync())
                {
                    var buf = new byte[length];
                    int got = 0;
                    while ((ulong)got < length)
                    {
                        int n = await body.ReadAsync(buf, got, (int)Math.Min(1048576UL, length - (ulong)got), ct);
                        if (n <= 0) break;
                        got += n;
                    }
                    Interlocked.Add(ref s.Bytes, got);
                    return got == buf.Length ? buf : Slice(buf, 0, got);
                }
            }
        }

        public bool CanRead { get { return true; } }
        public bool CanWrite { get { return false; } }
        public ulong Position { get { return position; } }
        public ulong Size
        {
            get { return shared.Size; }
            set { throw new NotSupportedException(); }
        }

        public void Seek(ulong p)
        {
            position = p;
        }

        public IRandomAccessStream CloneStream()
        {
            return new HttpRangeStream(shared);
        }

        public IInputStream GetInputStreamAt(ulong p)
        {
            var c = new HttpRangeStream(shared);
            c.Seek(p);
            return c;
        }

        public IOutputStream GetOutputStreamAt(ulong p)
        {
            throw new NotSupportedException();
        }

        public IAsyncOperationWithProgress<uint, uint> WriteAsync(IBuffer buffer)
        {
            throw new NotSupportedException();
        }

        public IAsyncOperation<bool> FlushAsync()
        {
            return AsyncInfo.Run(ct => Task.FromResult(true));
        }

        public IAsyncOperationWithProgress<IBuffer, uint> ReadAsync(IBuffer buffer, uint count, InputStreamOptions options)
        {
            return AsyncInfo.Run<IBuffer, uint>(async (ct, progress) =>
            {
                await gate.WaitAsync(ct);
                try
                {
                    ulong size = shared.Size;
                    if (disposed || position >= size || count == 0) return new byte[0].AsBuffer();
                    int want = (int)Math.Min(count, size - position);
                    var arr = new byte[want];
                    int got = 0;
                    bool retried = false;
                    while (got < want)
                    {
                        ulong at = position + (ulong)got;

                        // Parts kept in memory (start of the file and its index).
                        ulong nextPinned = ulong.MaxValue;
                        bool fromMemory = false;
                        foreach (var kv in shared.Pinned)
                        {
                            ulong start = kv.Key, end = kv.Key + (ulong)kv.Value.Length;
                            if (at >= start && at < end)
                            {
                                int n = (int)Math.Min((ulong)(want - got), end - at);
                                Array.Copy(kv.Value, (int)(at - start), arr, got, n);
                                got += n;
                                fromMemory = true;
                                Interlocked.Increment(ref shared.MemoryHits);
                                break;
                            }
                            if (start > at && start < nextPinned) nextPinned = start;
                        }
                        if (fromMemory) continue;

                        if (body == null || bodyPos != at) await OpenAt(at, ct);
                        int max = (int)Math.Min((ulong)(want - got), nextPinned - at);
                        int read = await body.ReadAsync(arr, got, max, ct);
                        if (read <= 0)
                        {
                            // The server closed the connection early; reconnect once from here.
                            Close();
                            if (retried) break;
                            retried = true;
                            continue;
                        }
                        got += read;
                        bodyPos += (ulong)read;
                        Interlocked.Add(ref shared.Bytes, read);
                        if ((options & InputStreamOptions.Partial) != 0) break;
                    }
                    position += (ulong)got;
                    return arr.AsBuffer(0, got);
                }
                finally
                {
                    gate.Release();
                }
            });
        }

        private async Task OpenAt(ulong p, CancellationToken ct)
        {
            Close();
            var sw = Stopwatch.StartNew();
            var req = new HttpRequestMessage(HttpMethod.Get, shared.Uri);
            req.Headers.Range = new RangeHeaderValue((long)p, null);
            Interlocked.Increment(ref shared.Requests);
            var r = await Http.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, ct);
            if (r.StatusCode != HttpStatusCode.PartialContent && !(p == 0 && r.IsSuccessStatusCode))
            {
                r.Dispose();
                throw new IOException("The media server didn't return the requested part of the video (" + (int)r.StatusCode + ").");
            }
            response = r;
            body = await r.Content.ReadAsStreamAsync();
            bodyPos = p;
            shared.Note((p / 1048576) + " MB in " + sw.ElapsedMilliseconds + " ms");
        }

        private void Close()
        {
            try { if (body != null) body.Dispose(); } catch { }
            try { if (response != null) response.Dispose(); } catch { }
            body = null;
            response = null;
        }

        public void Dispose()
        {
            disposed = true;
            Close();
        }
    }
}
