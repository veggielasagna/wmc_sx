using System;
using System.IO;
using Windows.Storage;

namespace WmcSx.Services
{
    /// <summary>
    /// Writes a plain-text log to LocalState\wmcsx_log.txt so problems can be read
    /// from the Xbox Device Portal's File explorer.
    /// </summary>
    public static class Log
    {
        private static readonly object gate = new object();
        private static string path;

        public static string FilePath
        {
            get
            {
                if (path == null)
                {
                    try { path = Path.Combine(ApplicationData.Current.LocalFolder.Path, "wmcsx_log.txt"); }
                    catch { path = ""; }
                }
                return path;
            }
        }

        public static void Start()
        {
            try
            {
                lock (gate)
                {
                    // Keep the previous run's log next to the new one.
                    var p = FilePath;
                    if (p.Length == 0) return;
                    if (File.Exists(p))
                    {
                        var old = p.Replace(".txt", "_previous.txt");
                        if (File.Exists(old)) File.Delete(old);
                        File.Move(p, old);
                    }
                }
            }
            catch
            {
            }
            Write("---- WMC SX starting " + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss"));
        }

        public static void Write(string message)
        {
            try
            {
                lock (gate)
                {
                    var p = FilePath;
                    if (p.Length == 0) return;
                    File.AppendAllText(p, DateTime.Now.ToString("HH:mm:ss.fff") + "  " + message + Environment.NewLine);
                }
            }
            catch
            {
            }
        }

        public static void Error(string where, Exception ex)
        {
            Write("ERROR in " + where + ": " + (ex == null ? "(no details)" : ex.GetType().FullName + ": " + ex.Message + " (0x" + ex.HResult.ToString("X8") + ")" + Environment.NewLine + ex.StackTrace));
            if (ex != null && ex.InnerException != null) Error(where + " (inner)", ex.InnerException);
        }
    }
}
