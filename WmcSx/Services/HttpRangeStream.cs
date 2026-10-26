using System;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Runtime.InteropServices.WindowsRuntime;
using System.Threading;
using System.Threading.Tasks;
using Windows.Foundation;
using Windows.Storage.Streams;

namespace WmcSx.Services
{
    /// <summary>
    /// Reads a video from the media server in byte ranges. The player can then jump straight to the
    /// index (at the end of most .mov files from Macs and capture cards) instead of waiting while the
    /// file streams in from the start.
    /// </summary>
    public sealed class HttpRangeStream : IRandomAccessStream
    {
        private static readonly HttpClient Http = CreateHttp();

        private readonly Uri uri;
        private readonly ulong size;
        private readonly SemaphoreSlim gate = new SemaphoreSlim(1, 1);
        private ulong position;
        private HttpResponseMessage response;
        private Stream body;
        private ulong bodyPos;
        private bool disposed;

        public string ContentType { get; private set; }
        public int Requests { get; private set; }
        public long BytesRead { get; private set; }

        private static HttpClient CreateHttp()
        {
            var c = new HttpClient();
            c.Timeout = Timeout.InfiniteTimeSpan;
            c.DefaultRequestHeaders.TryAddWithoutValidation("User-Agent", "WMCSX/1.0 UPnP/1.1 DLNADOC/1.50");
            return c;
        }

        private HttpRangeStream(Uri uri, ulong size, string contentType)
        {
            this.uri = uri;
            this.size = size;
            ContentType = contentType;
        }

        /// <summary>Returns null when the server doesn't support byte ranges.</summary>
        public static async Task<HttpRangeStream> TryOpen(Uri uri, TimeSpan timeout)
        {
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
                    return new HttpRangeStream(uri, (ulong)range.Length.Value, type);
                }
            }
        }

        public bool CanRead { get { return true; } }
        public bool CanWrite { get { return false; } }
        public ulong Position { get { return position; } }
        public ulong Size
        {
            get { return size; }
            set { throw new NotSupportedException(); }
        }

        public void Seek(ulong p)
        {
            position = p;
        }

        public IRandomAccessStream CloneStream()
        {
            return new HttpRangeStream(uri, size, ContentType);
        }

        public IInputStream GetInputStreamAt(ulong p)
        {
            var c = new HttpRangeStream(uri, size, ContentType);
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
                    if (disposed || position >= size || count == 0) return new byte[0].AsBuffer();
                    int want = (int)Math.Min(count, size - position);
                    var arr = new byte[want];
                    int got = 0;
                    bool retried = false;
                    while (got < want)
                    {
                        if (body == null || bodyPos != position + (ulong)got) await OpenAt(position + (ulong)got, ct);
                        int n = await body.ReadAsync(arr, got, want - got, ct);
                        if (n <= 0)
                        {
                            // The server closed the connection early; reconnect once from here.
                            Close();
                            if (retried) break;
                            retried = true;
                            continue;
                        }
                        got += n;
                        bodyPos += (ulong)n;
                        if ((options & InputStreamOptions.Partial) != 0) break;
                    }
                    position += (ulong)got;
                    BytesRead += got;
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
            var req = new HttpRequestMessage(HttpMethod.Get, uri);
            req.Headers.Range = new RangeHeaderValue((long)p, null);
            Requests++;
            var r = await Http.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, ct);
            if (r.StatusCode != HttpStatusCode.PartialContent && !(p == 0 && r.IsSuccessStatusCode))
            {
                r.Dispose();
                throw new IOException("The media server didn't return the requested part of the video (" + (int)r.StatusCode + ").");
            }
            response = r;
            body = await r.Content.ReadAsStreamAsync();
            bodyPos = p;
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
