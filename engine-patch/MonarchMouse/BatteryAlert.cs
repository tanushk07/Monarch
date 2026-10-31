using System;
using System.Globalization;
using System.IO;

namespace MonarchMouse
{
    // The low battery warning: one notification when the level drops to the chosen percentage.
    //
    // Readings jitter (20, 21, 20, 21...), so the warning is re-armed only once the mouse charges
    // or the reading climbs ReArm points above the level. Without that gap, a battery sitting on
    // the level would warn on every reading.
    internal sealed class BatteryAlert
    {
        public const int ReArm = 5;

        public bool On = true;
        public int At = 20;
        bool warned;

        public static int Clamp(int at) => Math.Max(5, Math.Min(50, (int)Math.Round(at / 5.0) * 5));

        // A new setting re-arms the warning, so the next reading is checked against it at once.
        public void Set(bool on, int at) { On = on; At = Clamp(at); warned = false; }

        // Call with every reading. True means: show the notification now.
        public bool Check(int percent, bool charging)
        {
            if (!On) { warned = false; return false; }
            if (charging || percent >= At + ReArm) { warned = false; return false; }
            if (warned || percent > At) return false;
            warned = true;
            return true;
        }

        // ---------------------------------------------------------------- saved in Monarch's data folder
        static string FilePath => Path.Combine(Host.DataDir, "mouse-battery.txt");

        public static BatteryAlert Load()
        {
            var a = new BatteryAlert();
            try
            {
                if (!File.Exists(FilePath)) return a;
                foreach (var line in File.ReadAllLines(FilePath))
                {
                    var kv = line.Split(new[] { '=' }, 2);
                    if (kv.Length != 2) continue;
                    if (kv[0].Trim() == "on") a.On = kv[1].Trim() != "0";
                    else if (kv[0].Trim() == "at" && int.TryParse(kv[1].Trim(), NumberStyles.Integer, CultureInfo.InvariantCulture, out var at)) a.At = Clamp(at);
                }
            }
            catch (Exception ex) { Host.Warn("read setting: " + ex.Message); }
            return a;
        }

        public void Save()
        {
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(FilePath));
                File.WriteAllText(FilePath, "on=" + (On ? "1" : "0") + "\r\nat=" + At.ToString(CultureInfo.InvariantCulture) + "\r\n");
            }
            catch (Exception ex) { Host.Warn("save setting: " + ex.Message); }
        }
    }
}
