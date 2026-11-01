using System;
using System.Collections.Generic;
using System.Threading;
using HidSharp;

namespace MonarchMouse
{
    // An open line to the mouse's vendor interface (through the dongle, the cable, or Bluetooth when
    // the mouse offers it there). It stays open and reads everything the mouse sends, for two
    // reasons:
    //  - The battery reply 51 02 PP CC SS can carry a stale charging state; asking twice in a row
    //    gives a fresh one on some firmware, so a check asks twice.
    //  - The mouse also sends reports nobody asked for, for example when the cable is plugged in or
    //    pulled out. A line that only opened for a moment every 30 seconds missed them, which is why
    //    charging only changed when the link was re-established.
    // Windows gives each open handle its own copy of every report, so Monarch's own reader is
    // unaffected.
    internal sealed class VendorLink : IDisposable
    {
        public readonly HidDevice Device;
        public readonly string Name;           // "dongle", "cable" or "bluetooth", for the log
        readonly HidStream stream;
        readonly int outLen;
        readonly AutoResetEvent got = new AutoResetEvent(false);
        volatile bool open = true;
        Reading? lastReply;

        // Charging as the mouse announced it by itself, and when; null until it does.
        public volatile Announcement Announced;

        // Raised (on this link's reader thread) when the mouse sends something nobody asked for.
        public event Action Unprompted;

        public sealed class Announcement { public int Percent; public bool Charging; public DateTime At; }

        VendorLink(HidDevice dev, HidStream s, string name)
        {
            Device = dev; stream = s; Name = name;
            outLen = Math.Max(2, Safe(dev.GetMaxOutputReportLength));
            stream.ReadTimeout = 1000;
            stream.WriteTimeout = 1000;
            new Thread(Read) { IsBackground = true, Name = "mouse-battery-read" }.Start();
        }

        public static VendorLink Open(HidDevice dev, string name)
        {
            try { return dev.TryOpen(out HidStream s) ? new VendorLink(dev, s, name) : null; }
            catch (Exception ex) { Host.Warn("open " + name + ": " + ex.Message); return null; }
        }

        public bool Alive => open;

        // Asks for the battery `rounds` times and returns the last answer, or null when the mouse
        // didn't answer (asleep, off, or on another link).
        public Reading? Request(object gate, int rounds = 2)
        {
            Reading? r = null;
            for (int i = 0; i < rounds && open; i++)
            {
                got.Reset();
                var req = new byte[outLen];
                req[0] = 0x50; req[1] = 0x02;
                try { lock (gate ?? got) stream.Write(req); }
                catch (Exception ex) { Host.Warn("write " + Name + ": " + ex.Message); Close(); return r; }
                if (!got.WaitOne(1000) || !open) break;
                lock (got) r = lastReply;
            }
            return r;
        }

        // ---------------------------------------------------------------- the reader thread
        // Replies to commands (request id + 1) and acknowledgements carry nothing new.
        static readonly HashSet<byte> Replies = new HashSet<byte> { 0x11, 0x33, 0x41, 0xFF };
        const int ChattyAfter = 5;
        readonly Dictionary<byte, string> lastSeen = new Dictionary<byte, string>();
        readonly Dictionary<byte, int> changes = new Dictionary<byte, int>();
        string lastReplyBytes;
        int logged;

        void Read()
        {
            var buf = new byte[Math.Max(65, Safe(Device.GetMaxInputReportLength))];
            while (open)
            {
                int n;
                try { n = stream.Read(buf); }
                catch (TimeoutException) { continue; }
                catch (Exception ex) { if (open) Host.Info(Name + " line closed: " + ex.Message); Close(); break; }
                if (n <= 0) continue;
                try { Handle(buf, n); } catch (Exception ex) { Host.Warn("read " + Name + ": " + ex.Message); }
            }
        }

        void Handle(byte[] b, int n)
        {
            var r = UsbBattery.Parse(b, n);
            if (r != null)
            {
                // Log each new reply pattern (bytes 2-6), so plugging in and out shows which bytes change.
                string key = BitConverter.ToString(b, 2, Math.Min(5, n - 2));
                if (key != lastReplyBytes) { lastReplyBytes = key; Log("battery reply on " + Name + ": " + r.Value.Raw); }
                lock (got) lastReply = r;
                got.Set();
                return;
            }
            byte id = b[0];
            if (Replies.Contains(id)) return;

            // Something the mouse sent by itself. Repeats of the same report are ignored; a change
            // is worth a fresh check. A report that keeps changing (an echo of the lighting Monarch
            // streams to the mouse, say) is chatter, not news, and is ignored after a few.
            string bytes = BitConverter.ToString(b, 0, Math.Min(n, 12));
            if (lastSeen.TryGetValue(id, out var prev) && prev == bytes) return;
            lastSeen[id] = bytes;
            changes.TryGetValue(id, out int c);
            changes[id] = ++c;
            if (c > ChattyAfter) { if (c == ChattyAfter + 1) Log("report " + id.ToString("X2") + " on " + Name + " changes often; ignoring it from now on"); return; }
            Log("unprompted report on " + Name + ": " + bytes);

            // The plug/unplug report one tool decodes: byte 6 is 0x03, byte 1 the percent,
            // byte 4 the power source (00 cable, FF battery), byte 3 the charge phase.
            if (n >= 7 && b[6] == 0x03 && b[1] <= 100)
            {
                bool? chg = b[4] == 0x00 ? true : b[4] == 0xFF ? false : b[3] == 0x02 ? true : b[3] == 0xFE ? false : (bool?)null;
                if (chg != null) Announced = new Announcement { Percent = b[1], Charging = chg.Value, At = DateTime.UtcNow };
            }
            try { Unprompted?.Invoke(); } catch { }
        }

        void Log(string msg) { if (logged++ < 200) Host.Info(msg); }

        void Close()
        {
            open = false;
            try { stream.Dispose(); } catch { }
            got.Set();
        }

        public void Dispose() => Close();

        static int Safe(Func<int> f) { try { return f(); } catch { return 0; } }
    }
}
