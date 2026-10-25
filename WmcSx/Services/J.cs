using System;
using Windows.Data.Json;

namespace WmcSx.Services
{
    /// <summary>Small helpers for reading and writing Windows.Data.Json values.</summary>
    internal static class J
    {
        public static string Str(JsonObject o, string key, string def = null)
        {
            if (o == null) return def;
            IJsonValue v;
            if (!o.TryGetValue(key, out v) || v == null) return def;
            switch (v.ValueType)
            {
                case JsonValueType.String: return v.GetString();
                case JsonValueType.Number: return v.GetNumber().ToString(System.Globalization.CultureInfo.InvariantCulture);
                case JsonValueType.Boolean: return v.GetBoolean() ? "true" : "false";
                default: return def;
            }
        }

        public static double Num(JsonObject o, string key, double def = 0)
        {
            if (o == null) return def;
            IJsonValue v;
            if (!o.TryGetValue(key, out v) || v == null) return def;
            if (v.ValueType == JsonValueType.Number) return v.GetNumber();
            double d;
            if (v.ValueType == JsonValueType.String && double.TryParse(v.GetString(), System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out d)) return d;
            return def;
        }

        public static bool Bool(JsonObject o, string key, bool def = false)
        {
            if (o == null) return def;
            IJsonValue v;
            if (!o.TryGetValue(key, out v) || v == null) return def;
            if (v.ValueType == JsonValueType.Boolean) return v.GetBoolean();
            return def;
        }

        public static JsonArray Arr(JsonObject o, string key)
        {
            if (o == null) return new JsonArray();
            IJsonValue v;
            if (!o.TryGetValue(key, out v) || v == null || v.ValueType != JsonValueType.Array) return new JsonArray();
            return v.GetArray();
        }

        public static IJsonValue S(string s)
        {
            return s == null ? JsonValue.CreateNullValue() : (IJsonValue)JsonValue.CreateStringValue(s);
        }

        public static IJsonValue N(double d)
        {
            if (double.IsNaN(d) || double.IsInfinity(d)) d = 0;
            return JsonValue.CreateNumberValue(d);
        }

        public static IJsonValue B(bool b)
        {
            return JsonValue.CreateBooleanValue(b);
        }

        public static void Set(JsonObject o, string key, string s)
        {
            if (s != null) o[key] = JsonValue.CreateStringValue(s);
        }
    }
}
