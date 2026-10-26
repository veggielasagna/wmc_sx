using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Net.Http;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using System.Xml.Linq;
using Windows.Data.Json;
using Windows.Networking;
using Windows.Networking.Sockets;
using Windows.Storage.Streams;

namespace WmcSx.Services
{
    public sealed class DlnaServer
    {
        public string Id;
        public string Name;
        public string Location;
        public string ControlUrl;
        public string ServiceType;
        public string Host;
        public string Model;
        public string Manufacturer;
        public string IconUrl;

        public JsonObject ToJson()
        {
            var o = new JsonObject();
            o["id"] = J.S(Id);
            o["name"] = J.S(Name);
            o["location"] = J.S(Location);
            o["host"] = J.S(Host);
            o["model"] = J.S(Model);
            o["manufacturer"] = J.S(Manufacturer);
            o["icon"] = J.S(IconUrl);
            return o;
        }
    }

    /// <summary>
    /// Finds DLNA/UPnP media servers on the home network (SSDP) and browses
    /// their ContentDirectory service. No login is involved; this is the same
    /// protocol the Xbox's own media player uses.
    /// </summary>
    public static class Dlna
    {
        private static readonly HttpClient Http = CreateHttp();
        private static readonly Dictionary<string, DlnaServer> servers = new Dictionary<string, DlnaServer>();
        private static readonly HashSet<string> seenLocations = new HashSet<string>();
        private static DatagramSocket socket;

        public static event Action<DlnaServer> ServerFound;

        private static HttpClient CreateHttp()
        {
            var c = new HttpClient();
            c.Timeout = TimeSpan.FromSeconds(20);
            c.DefaultRequestHeaders.TryAddWithoutValidation("User-Agent", "WMCSX/1.0 UPnP/1.1 DLNADOC/1.50");
            return c;
        }

        public static HttpClient Client { get { return Http; } }

        public static List<DlnaServer> Servers
        {
            get { lock (servers) return servers.Values.ToList(); }
        }

        /// <summary>Sends SSDP searches. Pass an IP address to ask one device directly.</summary>
        public static async Task Discover(string unicastIp = null)
        {
            if (socket == null)
            {
                socket = new DatagramSocket();
                socket.MessageReceived += OnMessage;
                await socket.BindServiceNameAsync("");
            }
            if (unicastIp == null)
            {
                lock (seenLocations) seenLocations.Clear();
            }

            string[] targets =
            {
                "urn:schemas-upnp-org:device:MediaServer:1",
                "urn:schemas-upnp-org:service:ContentDirectory:1",
                "ssdp:all"
            };
            var host = new HostName(unicastIp ?? "239.255.255.250");
            for (int round = 0; round < 2; round++)
            {
                foreach (var st in targets)
                {
                    string msg =
                        "M-SEARCH * HTTP/1.1\r\n" +
                        "HOST: 239.255.255.250:1900\r\n" +
                        "MAN: \"ssdp:discover\"\r\n" +
                        "MX: 2\r\n" +
                        "ST: " + st + "\r\n" +
                        "USER-AGENT: WMCSX/1.0 UPnP/1.1\r\n\r\n";
                    try
                    {
                        var stream = await socket.GetOutputStreamAsync(host, "1900");
                        var w = new DataWriter(stream);
                        w.WriteString(msg);
                        await w.StoreAsync();
                        w.DetachStream();
                        w.Dispose();
                    }
                    catch
                    {
                        // Network not ready or blocked; the next round may succeed.
                    }
                }
                await Task.Delay(800);
            }
        }

        private static void OnMessage(DatagramSocket sender, DatagramSocketMessageReceivedEventArgs e)
        {
            try
            {
                var reader = e.GetDataReader();
                string text = reader.ReadString(reader.UnconsumedBufferLength);
                string location = Header(text, "LOCATION");
                if (string.IsNullOrEmpty(location)) return;
                lock (seenLocations)
                {
                    if (!seenLocations.Add(location)) return;
                }
                var ignored = LoadDescription(location);
            }
            catch
            {
                // Ignore malformed packets and ICMP errors.
            }
        }

        private static string Header(string text, string name)
        {
            foreach (var raw in text.Split('\n'))
            {
                var line = raw.Trim();
                int colon = line.IndexOf(':');
                if (colon <= 0) continue;
                if (string.Equals(line.Substring(0, colon).Trim(), name, StringComparison.OrdinalIgnoreCase))
                {
                    return line.Substring(colon + 1).Trim();
                }
            }
            return null;
        }

        /// <summary>Reads a device description and registers any media server it contains.</summary>
        public static async Task<List<DlnaServer>> LoadDescription(string location)
        {
            var found = new List<DlnaServer>();
            try
            {
                string xml;
                using (var descResp = await Http.GetAsync(location))
                {
                    xml = await ReadText(descResp);
                }
                var doc = XDocument.Parse(xml);
                XNamespace ns = doc.Root.Name.Namespace;
                string urlBase = (string)doc.Root.Element(ns + "URLBase");
                var baseUri = new Uri(string.IsNullOrWhiteSpace(urlBase) ? location : urlBase.Trim());

                foreach (var dev in doc.Descendants(ns + "device"))
                {
                    var serviceList = dev.Element(ns + "serviceList");
                    if (serviceList == null) continue;
                    var svc = serviceList.Elements(ns + "service").FirstOrDefault(x =>
                        ((string)x.Element(ns + "serviceType") ?? "").Contains(":service:ContentDirectory:"));
                    if (svc == null) continue;

                    string control = ((string)svc.Element(ns + "controlURL") ?? "").Trim();
                    var server = new DlnaServer
                    {
                        Id = ((string)dev.Element(ns + "UDN") ?? location).Trim(),
                        Name = ((string)dev.Element(ns + "friendlyName") ?? "Media server").Trim(),
                        Model = ((string)dev.Element(ns + "modelName") ?? "").Trim(),
                        Manufacturer = ((string)dev.Element(ns + "manufacturer") ?? "").Trim(),
                        Location = location,
                        ServiceType = ((string)svc.Element(ns + "serviceType")).Trim(),
                        ControlUrl = new Uri(baseUri, control).ToString(),
                        Host = new Uri(location).Host
                    };

                    var icons = dev.Element(ns + "iconList");
                    if (icons != null)
                    {
                        var best = icons.Elements(ns + "icon")
                            .OrderByDescending(i => ((string)i.Element(ns + "mimetype") ?? "").Contains("png") ? 1 : 0)
                            .ThenByDescending(i => ParseInt((string)i.Element(ns + "width"), 0))
                            .FirstOrDefault();
                        if (best != null && best.Element(ns + "url") != null)
                        {
                            server.IconUrl = new Uri(baseUri, ((string)best.Element(ns + "url")).Trim()).ToString();
                        }
                    }

                    lock (servers) servers[server.Id] = server;
                    found.Add(server);
                    var handler = ServerFound;
                    if (handler != null) handler(server);
                }
            }
            catch
            {
                lock (seenLocations) seenLocations.Remove(location);
            }
            return found;
        }

        /// <summary>
        /// Reads a reply as UTF-8 text. Some NAS media servers send Content-Type
        /// headers like charset="utf-8" (with quotes), which ReadAsStringAsync rejects.
        /// </summary>
        private static async Task<string> ReadText(HttpResponseMessage resp)
        {
            var bytes = await resp.Content.ReadAsByteArrayAsync();
            var text = Encoding.UTF8.GetString(bytes);
            if (text.Length > 0 && text[0] == '\uFEFF') text = text.Substring(1);
            return text;
        }

        public static DlnaServer Get(string id)
        {
            DlnaServer s;
            lock (servers) servers.TryGetValue(id ?? "", out s);
            return s;
        }

        /// <summary>Lists the children of a container. Returns items and the server's total count.</summary>
        public static async Task<JsonObject> Browse(string serverId, string objectId, int start, int count)
        {
            var srv = Get(serverId);
            if (srv == null) throw new Exception("That media server isn't connected.");

            string body =
                "<?xml version=\"1.0\" encoding=\"utf-8\"?>" +
                "<s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\" s:encodingStyle=\"http://schemas.xmlsoap.org/soap/encoding/\">" +
                "<s:Body><u:Browse xmlns:u=\"" + srv.ServiceType + "\">" +
                "<ObjectID>" + XmlEscape(objectId) + "</ObjectID>" +
                "<BrowseFlag>BrowseDirectChildren</BrowseFlag>" +
                "<Filter>*</Filter>" +
                "<StartingIndex>" + start.ToString(CultureInfo.InvariantCulture) + "</StartingIndex>" +
                "<RequestedCount>" + count.ToString(CultureInfo.InvariantCulture) + "</RequestedCount>" +
                "<SortCriteria></SortCriteria>" +
                "</u:Browse></s:Body></s:Envelope>";

            var req = new HttpRequestMessage(HttpMethod.Post, srv.ControlUrl);
            req.Content = new StringContent(body, Encoding.UTF8, "text/xml");
            req.Headers.TryAddWithoutValidation("SOAPACTION", "\"" + srv.ServiceType + "#Browse\"");

            var resp = await Http.SendAsync(req);
            string xml = await ReadText(resp);
            if (!resp.IsSuccessStatusCode)
            {
                throw new Exception("The media server answered with error " + (int)resp.StatusCode + ".");
            }

            var doc = XDocument.Parse(xml);
            var resultEl = doc.Descendants().FirstOrDefault(x => x.Name.LocalName == "Result");
            var totalEl = doc.Descendants().FirstOrDefault(x => x.Name.LocalName == "TotalMatches");
            var returnedEl = doc.Descendants().FirstOrDefault(x => x.Name.LocalName == "NumberReturned");

            var items = ParseDidl(resultEl != null ? resultEl.Value : "");
            var arr = new JsonArray();
            foreach (var it in items) arr.Add(it);

            var o = new JsonObject();
            o["items"] = arr;
            o["total"] = J.N(ParseInt(totalEl != null ? totalEl.Value : null, items.Count));
            o["returned"] = J.N(ParseInt(returnedEl != null ? returnedEl.Value : null, items.Count));
            return o;
        }

        private static List<JsonObject> ParseDidl(string didl)
        {
            var list = new List<JsonObject>();
            if (string.IsNullOrWhiteSpace(didl)) return list;

            XDocument d;
            try { d = XDocument.Parse(didl); }
            catch { d = XDocument.Parse(FixAmpersands(didl)); }

            foreach (var el in d.Root.Elements())
            {
                string ln = el.Name.LocalName;
                if (ln != "container" && ln != "item") continue;

                var o = new JsonObject();
                o["id"] = J.S((string)el.Attribute("id") ?? "");
                string cls = Child(el, "class") ?? "";
                o["title"] = J.S(Child(el, "title") ?? "Untitled");
                o["cls"] = J.S(cls);
                J.Set(o, "artist", Child(el, "artist") ?? Child(el, "albumArtist") ?? Child(el, "creator"));
                J.Set(o, "album", Child(el, "album"));
                J.Set(o, "genre", Child(el, "genre"));
                J.Set(o, "date", Child(el, "date"));
                int track = ParseInt(Child(el, "originalTrackNumber"), 0);
                if (track > 0) o["track"] = J.N(track);
                string art = Child(el, "albumArtURI");

                if (ln == "container")
                {
                    o["kind"] = J.S("container");
                    int cc = ParseInt((string)el.Attribute("childCount"), -1);
                    if (cc >= 0) o["childCount"] = J.N(cc);
                }
                else
                {
                    string kind = cls.Contains("audioItem") ? "audio"
                        : cls.Contains("videoItem") ? "video"
                        : cls.Contains("imageItem") ? "image"
                        : "other";
                    o["kind"] = J.S(kind);

                    XElement main = null, thumb = null;
                    string mainMime = null;
                    var full = new List<XElement>();
                    foreach (var r in el.Elements().Where(x => x.Name.LocalName == "res"))
                    {
                        string pi = (string)r.Attribute("protocolInfo") ?? "";
                        string mime = MimeOf(pi);
                        bool isThumb = pi.Contains("_TN") || pi.Contains("JPEG_SM") || pi.Contains("PNG_SM");
                        if (isThumb || (kind != "image" && mime.StartsWith("image/")))
                        {
                            if (thumb == null) thumb = r;
                            continue;
                        }
                        full.Add(r);
                        if (main == null)
                        {
                            main = r;
                            mainMime = mime;
                        }
                    }
                    if (main == null) main = el.Elements().FirstOrDefault(x => x.Name.LocalName == "res");
                    if (main != null)
                    {
                        o["url"] = J.S(main.Value.Trim());
                        J.Set(o, "mime", mainMime);
                        J.Set(o, "pi", (string)main.Attribute("protocolInfo"));
                        double dur = ParseDuration((string)main.Attribute("duration"));
                        if (dur > 0) o["duration"] = J.N(dur);
                        J.Set(o, "resolution", (string)main.Attribute("resolution"));
                        J.Set(o, "size", (string)main.Attribute("size"));
                    }

                    // Photos the interface can't show (HEIC from iPhones, TIFF, RAW): use the largest
                    // JPEG or PNG version the server also offers, if any.
                    if (kind == "image" && main != null && !WebSafeImage(mainMime))
                    {
                        XElement best = null;
                        long bestPx = -1;
                        foreach (var r in el.Elements().Where(x => x.Name.LocalName == "res"))
                        {
                            if (!WebSafeImage(MimeOf((string)r.Attribute("protocolInfo") ?? ""))) continue;
                            long px = Pixels((string)r.Attribute("resolution"));
                            if (px > bestPx)
                            {
                                best = r;
                                bestPx = px;
                            }
                        }
                        if (best != null) o["view"] = J.S(best.Value.Trim());
                        if (!loggedImageRes)
                        {
                            loggedImageRes = true;
                            var sb = new System.Text.StringBuilder("DLNA: photo in " + mainMime + " offers:");
                            foreach (var r in el.Elements().Where(x => x.Name.LocalName == "res"))
                                sb.Append(" [" + (string)r.Attribute("protocolInfo") + " " + (string)r.Attribute("resolution") + "]");
                            Log.Write(sb.ToString());
                        }
                    }

                    // Videos: if the server offers an MP4 version next to the original, prefer it.
                    if (kind == "video" && main != null && mainMime != "video/mp4")
                    {
                        var mp4 = full.FirstOrDefault(r => MimeOf((string)r.Attribute("protocolInfo") ?? "") == "video/mp4");
                        if (mp4 != null) o["url"] = J.S(mp4.Value.Trim());
                    }

                    if (art == null && thumb != null) art = thumb.Value.Trim();
                    if (thumb != null) o["thumb"] = J.S(thumb.Value.Trim());
                }
                J.Set(o, "art", art);
                list.Add(o);
            }
            return list;
        }

        private static bool loggedImageRes;

        public static bool WebSafeImage(string mime)
        {
            mime = (mime ?? "").ToLowerInvariant();
            return mime == "image/jpeg" || mime == "image/jpg" || mime == "image/png" || mime == "image/gif" || mime == "image/bmp" || mime == "image/webp";
        }

        private static long Pixels(string resolution)
        {
            // "4032x3024"
            if (string.IsNullOrEmpty(resolution)) return 0;
            var p = resolution.ToLowerInvariant().Split('x');
            long w, h;
            if (p.Length == 2 && long.TryParse(p[0], out w) && long.TryParse(p[1], out h)) return w * h;
            return 0;
        }

        private static string Child(XElement el, string localName)
        {
            var c = el.Elements().FirstOrDefault(x => x.Name.LocalName == localName);
            if (c == null) return null;
            var v = c.Value.Trim();
            return v.Length == 0 ? null : v;
        }

        private static string MimeOf(string protocolInfo)
        {
            var parts = protocolInfo.Split(':');
            return parts.Length >= 3 ? parts[2].ToLowerInvariant() : "";
        }

        private static string FixAmpersands(string s)
        {
            return Regex.Replace(s, "&(?!(amp|lt|gt|quot|apos|#[0-9]+|#x[0-9a-fA-F]+);)", "&amp;");
        }

        private static string XmlEscape(string s)
        {
            if (s == null) return "";
            return s.Replace("&", "&amp;").Replace("<", "&lt;").Replace(">", "&gt;").Replace("\"", "&quot;").Replace("'", "&apos;");
        }

        public static int ParseInt(string s, int def)
        {
            int v;
            return int.TryParse((s ?? "").Trim(), NumberStyles.Integer, CultureInfo.InvariantCulture, out v) ? v : def;
        }

        private static double ParseDuration(string s)
        {
            // "H:MM:SS.mmm"
            if (string.IsNullOrWhiteSpace(s)) return 0;
            var parts = s.Trim().Split(':');
            double total = 0;
            foreach (var p in parts)
            {
                double v;
                if (!double.TryParse(p, NumberStyles.Float, CultureInfo.InvariantCulture, out v)) return 0;
                total = total * 60 + v;
            }
            return total;
        }
    }
}
