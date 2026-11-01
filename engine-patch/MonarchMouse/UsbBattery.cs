using System;
using System.Collections.Generic;
using System.Linq;
using HidSharp;

namespace MonarchMouse
{
    internal struct Reading
    {
        public int Percent;
        public bool Charging;
        public string Raw;      // first bytes of the reply, logged once to confirm the charging bytes
    }

    // The battery through the dongle or the cable. The mouse answers a 64-byte vendor report
    // 50 02 00 ... with 51 02 PP CC SS: PP is the percent, CC the charge state, SS the power source.
    // Same interface (2) and report layout Monarch already uses for DPI (32 02 -> 33 02).
    //
    // This opens its own handle to the interface. Windows gives each open handle its own copy of
    // every input report, so Monarch's reader thread is untouched and sees the reply too (it
    // ignores 51 02).
    internal static class UsbBattery
    {
        public const int Vid = 0x03F0;
        // Monarch's own product ids (MouseDevice.PIDS), split by what they are.
        public static readonly int[] Dongles = { 0x0F98, 0x0BA0 };          // Haste 2, Haste 2 Mini receivers
        public static readonly int[] Cables = { 0x0B97, 0x0D97, 0x0DA0 };   // the mouse itself on USB

        // The vendor interface of the first of these products that is plugged in, the same way
        // Monarch picks it.
        public static HidDevice Find(int[] pids)
        {
            List<HidDevice> all;
            try { all = DeviceList.Local.GetHidDevices().Where(d => d.VendorID == Vid).ToList(); }
            catch (Exception ex) { Host.Warn("hid list: " + ex.Message); return null; }
            foreach (int pid in pids)
            {
                var d = all.Where(x => x.ProductID == pid && (x.DevicePath ?? "").ToLowerInvariant().Contains("mi_02"))
                           .OrderByDescending(x => Safe(x.GetMaxOutputReportLength)).FirstOrDefault();
                if (d != null && Safe(d.GetMaxOutputReportLength) >= 64) return d;
            }
            return null;
        }

        // Over Bluetooth the mouse may offer the same vendor reports through Windows' HID-over-
        // Bluetooth driver. That channel's path names the HID-over-GATT service {00001812-...}
        // instead of a USB interface, and its report list shows whether the battery command
        // (output 0x50, input 0x51) is there. If it is, it also says whether the mouse is charging,
        // which the standard Bluetooth Battery Service doesn't.
        public static HidDevice FindBluetoothVendor()
        {
            List<HidDevice> all;
            try
            {
                all = DeviceList.Local.GetHidDevices().Where(d =>
                {
                    string p = (d.DevicePath ?? "").ToLowerInvariant();
                    return p.Contains("{00001812-") && (d.VendorID == Vid || p.Contains("03f0"));
                }).ToList();
            }
            catch (Exception ex) { Host.Warn("hid list: " + ex.Message); return null; }
            foreach (var d in all)
            {
                try
                {
                    var rd = d.GetReportDescriptor();
                    if (rd.OutputReports.Any(r => r.ReportID == 0x50) && rd.InputReports.Any(r => r.ReportID == 0x51)) return d;
                }
                catch { }
            }
            return null;
        }

        // Null when nothing answered within a second: the mouse is asleep, off, or on another link.
        public static Reading? Request(HidDevice dev, object gate)
        {
            if (!dev.TryOpen(out HidStream s)) return null;
            using (s)
            {
                s.ReadTimeout = 250;
                s.WriteTimeout = 1000;
                var req = new byte[dev.GetMaxOutputReportLength()];
                req[0] = 0x50; req[1] = 0x02;
                lock (gate ?? new object()) s.Write(req);

                var buf = new byte[Math.Max(65, Safe(dev.GetMaxInputReportLength))];
                var until = DateTime.UtcNow.AddSeconds(1);
                while (DateTime.UtcNow < until)
                {
                    int n;
                    try { n = s.Read(buf); }
                    catch (TimeoutException) { continue; }
                    var r = Parse(buf, n);
                    if (r != null) return r;
                }
                return null;
            }
        }

        // 51 02 PP CC SS. PP is confirmed by two independent tools. What CC and SS mean comes from
        // one tool's reading of the bytes (SS 00 = on the cable, FF = on battery; CC 01, sometimes
        // 02 = charging), so the raw bytes are logged once to check on the real mouse.
        public static Reading? Parse(byte[] b, int n)
        {
            if (n < 5 || b[0] != 0x51 || b[1] != 0x02 || b[2] > 100) return null;
            byte cc = b[3], ss = b[4];
            return new Reading
            {
                Percent = b[2],
                Charging = ss == 0x00 || (ss != 0xFF && (cc == 0x01 || cc == 0x02)),
                Raw = BitConverter.ToString(b, 0, Math.Min(n, 8)),
            };
        }

        static int Safe(Func<int> f) { try { return f(); } catch { return 0; } }
    }
}
