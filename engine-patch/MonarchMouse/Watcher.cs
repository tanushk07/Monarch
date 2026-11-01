using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace MonarchMouse
{
    // Works out which link the mouse is on and how full its battery is, and sends the low battery
    // warning. One background thread; the page and the tray icon are only touched through
    // Host.Post, on Monarch's UI thread.
    //
    // The link needs evidence that the mouse itself is on it, checked in this order:
    //   1. the mouse's own USB device is present            -> "wired"
    //   2. Windows says the Bluetooth connection is up       -> "bluetooth"
    //   3. the mouse answers the battery request via dongle  -> "dongle"
    // A dongle that is merely plugged in proves nothing: it stays there when the mouse is switched
    // to Bluetooth, which is why Monarch used to say "through the USB dongle" over Bluetooth.
    internal static class Watcher
    {
        static readonly TimeSpan Every = TimeSpan.FromSeconds(15);       // while everything is known
        static readonly TimeSpan Searching = TimeSpan.FromSeconds(10);   // the mouse isn't answering
        static readonly TimeSpan Waiting = TimeSpan.FromSeconds(5);      // on Bluetooth, no real level yet
        static readonly TimeSpan KeepLevel = TimeSpan.FromMinutes(10);   // a reading this recent still stands
        const int MissesBeforeAsleep = 2;

        static readonly object gate = new object();
        static readonly AutoResetEvent wake = new AutoResetEvent(false);
        static Thread thread;
        static object mouseDevice;
        static BleBattery ble;
        static BatteryAlert alert;

        // Written by the watcher thread, read on the UI thread.
        static volatile string link;          // "wired", "bluetooth", "dongle", or null
        static volatile int battery = -1;     // 1-100, -1 until read
        static volatile bool charging;
        static volatile string chargingFrom;  // "cable", "mouse" (it said so), "level" (it went up), or null
        static volatile bool polled;          // false until the first check finishes
        static volatile bool dirty;           // the page hasn't seen the latest values
        static volatile bool woken;

        public static void Start(object md)
        {
            lock (gate)
            {
                if (thread != null) return;
                mouseDevice = md;
                Host.RememberAssembly(md.GetType().Assembly);
                alert = BatteryAlert.Load();
                thread = new Thread(Run) { IsBackground = true, Name = "mouse-battery" };
                thread.Start();
            }
        }

        // ---------------------------------------------------------------- the watcher thread
        static VendorLink line;   // the open line to the mouse on the current link

        // Keeps one line open to `dev`, reopening it when the device changes or the line dropped.
        static VendorLink LineTo(HidSharp.HidDevice dev, string name)
        {
            if (dev == null) { CloseLine(); return null; }
            if (line != null && line.Alive && line.Device.DevicePath == dev.DevicePath) return line;
            CloseLine();
            line = VendorLink.Open(dev, name);
            if (line != null) { line.Unprompted += Poke; Host.Info("listening on " + name); }
            return line;
        }

        static void CloseLine()
        {
            if (line == null) return;
            line.Unprompted -= Poke;
            line.Dispose();
            line = null;
        }

        static void Run()
        {
            try { ble = new BleBattery(); ble.Changed += Poke; }
            catch (Exception ex) { ble = null; Host.Warn("Bluetooth unavailable: " + ex.Message); }

            var rise = new RiseTracker();
            bool btVendorChecked = false;
            HidSharp.HidDevice btVendor = null;
            int misses = 0, btVendorMisses = 0;
            var next = DateTime.MinValue;
            var levelAt = DateTime.MinValue;    // when lastLevel was read
            int lastLevel = -1;                 // the last real reading, on any link
            DateTime linkSince = DateTime.UtcNow;
            string lastLog = null;
            while (true)
            {
                try
                {
                    if (DateTime.UtcNow >= next)
                    {
                        var t = DateTime.UtcNow;
                        lastCheck = t;
                        string was = link;
                        string now = null;
                        Reading? r = null;      // the mouse's own battery report
                        int btLevel = -1;       // the Bluetooth Battery Service
                        VendorLink used = null;

                        var cable = UsbBattery.Find(UsbBattery.Cables);
                        if (cable != null)
                        {
                            now = "wired";
                            used = LineTo(cable, "cable");
                            r = used?.Request(Host.WriteGate(mouseDevice));
                        }
                        else if (BluetoothUp())
                        {
                            now = "bluetooth";
                            if (was != "bluetooth") { btVendorChecked = false; btVendor = null; btVendorMisses = 0; }
                            // The mouse's own report says whether it is charging; look for it once per connection.
                            if (!btVendorChecked)
                            {
                                btVendorChecked = true;
                                btVendor = UsbBattery.FindBluetoothVendor();
                                Host.Info(btVendor != null ? "Bluetooth: the mouse offers its battery report, charging included" : "Bluetooth: no battery report from the mouse itself; using the Battery Service (no charging state)");
                            }
                            if (btVendor != null)
                            {
                                used = LineTo(btVendor, "bluetooth");
                                r = used?.Request(null);
                                if (r == null && ++btVendorMisses >= 3) { btVendor = null; Host.Info("Bluetooth: the mouse's battery report didn't answer; using the Battery Service"); }
                            }
                            else CloseLine();
                            if (r == null || r.Value.Percent == 0) btLevel = ble.ReadLevel() ?? -1;
                        }
                        else
                        {
                            var dongle = UsbBattery.Find(UsbBattery.Dongles);
                            used = LineTo(dongle, "dongle");
                            r = used?.Request(Host.WriteGate(mouseDevice));
                            if (r != null) { now = "dongle"; misses = 0; }
                            // one missed reply isn't sleep yet
                            else if (dongle != null && was == "dongle" && ++misses < MissesBeforeAsleep) now = "dongle";
                        }
                        if (now != "dongle") misses = 0;
                        if (now != was) linkSince = t;

                        // The level: a real reading wins. 0 is never real: a mouse that answers isn't
                        // empty, it just hasn't measured yet. Without a reading the last one stands
                        // for a while, also across a switch of link, so switching to Bluetooth
                        // doesn't blank the level while the mouse measures.
                        int fresh = r != null && r.Value.Percent > 0 ? r.Value.Percent : btLevel > 0 ? btLevel : -1;
                        if (fresh > 0) { lastLevel = fresh; levelAt = t; }
                        int pct = fresh > 0 ? fresh : now != null && lastLevel > 0 && t - levelAt < KeepLevel ? lastLevel : -1;

                        // Charging. On the cable it always is: USB powers the mouse. On the dongle,
                        // what the mouse announced by itself when the cable went in or out wins
                        // over the reply, whose charging bytes can lag; then the reply; then a
                        // rising level as a backup. Over Bluetooth, only the mouse's own report or
                        // a rising level can tell.
                        if (now != was) rise.Reset();
                        if (fresh > 0 && now != "wired") rise.Add(fresh, t);
                        var said = used?.Announced;
                        bool chg; string from = null;
                        if (now == "wired") { chg = true; from = "cable"; }
                        else if (now == "dongle" && r == null) { chg = charging; from = chargingFrom; }   // a missed reply: keep what we had
                        else if (said != null && said.At >= linkSince) { chg = said.Charging; from = chg ? "mouse" : null; }
                        else if (r != null && r.Value.Charging) { chg = true; from = "mouse"; }
                        else if (now != null && rise.Charging(t)) { chg = true; from = "level"; }
                        else chg = false;

                        Update(now, pct, chg, from);

                        // log the link, the charge state and each 10% step, not every reading
                        string key = (now ?? "not connected") + (pct > 0 ? ", about " + (pct / 10 * 10) + "%" : "") + (chg ? ", charging" : "");
                        if (key != lastLog) { lastLog = key; Host.Info((now ?? "not connected") + (pct > 0 ? ", " + pct + "%" : "") + (chg ? ", charging (" + from + ")" : "")); }

                        if (now == null) CloseLine();
                        next = t + (now == null || misses > 0 ? Searching
                                  : now == "bluetooth" && fresh <= 0 ? Waiting
                                  : Every);
                    }
                    if (dirty) Flush();
                }
                catch (Exception ex)
                {
                    Host.Warn("watch: " + ex.Message);
                    next = DateTime.UtcNow + Searching;
                }
                wake.WaitOne(1000);
                // A poke checks again soon, but not more than once every 2 seconds.
                if (woken) { woken = false; var soon = lastCheck + TimeSpan.FromSeconds(2); if (soon < next) next = soon; }
            }
        }
        static DateTime lastCheck = DateTime.MinValue;

        static bool BluetoothUp()
        {
            try { return ble != null && ble.Connected; }
            catch (Exception ex) { Host.Warn("Bluetooth: " + ex.Message); return false; }
        }

        // Asks for a check now instead of at the next interval: Bluetooth came up or went down, or
        // the mouse sent something by itself (a new level, the cable going in or out).
        static void Poke() { woken = true; wake.Set(); }

        static void Update(string now, int pct, bool chg, string from)
        {
            bool changed = now != link || pct != battery || chg != charging || from != chargingFrom || !polled;
            link = now; battery = pct; charging = chg; chargingFrom = from; polled = true;
            if (changed) dirty = true;
            if (now != null && pct > 0)
            {
                bool warn;
                lock (gate) warn = alert.Check(pct, chg);
                if (warn) Notify(pct, test: false);
            }
        }

        // Sends the latest values to the page once it is on screen. Monarch drops live updates
        // while its window is hidden, so this waits until it is visible.
        static void Flush()
        {
            Host.Post(() =>
            {
                if (!dirty || !Host.PageVisible()) return;
                dirty = false;
                Host.UiEvent("mouse", Host.MouseState());
            });
        }

        // ---------------------------------------------------------------- notification
        static void Notify(int pct, bool test)
        {
            string model = Host.Model(mouseDevice) ?? "The mouse";
            string text = test
                ? "This is how the low battery warning looks. " + model + " is at " + pct + "%."
                : model + " is at " + pct + "%. Plug in the USB cable to charge it.";
            Host.Info((test ? "test warning: " : "low battery warning: ") + pct + "%");
            bool posted = Host.Post(() =>
            {
                var tray = Host.Tray();
                if (tray != null) tray.ShowBalloonTip(10000, "Mouse battery low", text, ToolTipIcon.Warning);
                else Host.Warn("no tray icon for the warning");
                Host.UiEvent("toast", "Mouse battery low: " + pct + "%. Plug in the USB cable to charge it.");
            });
            if (!posted) Host.Warn("couldn't reach Monarch's window for the warning");
        }

        // ---------------------------------------------------------------- what the page sees
        public static void Decorate(Dictionary<string, object> d)
        {
            if (!polled || alert == null) return;   // nothing checked yet: leave Monarch's own values
            string l = link;
            int pct = battery;
            d["connected"] = l != null;
            d["wireless"] = l != null && l != "wired";
            d["connection"] = l;
            d["battery"] = l != null && pct > 0 ? (object)pct : null;
            d["charging"] = l != null && charging;
            d["chargingFrom"] = l != null && charging ? chargingFrom : null;
            lock (gate) d["batteryAlert"] = new Dictionary<string, object> { { "on", alert.On }, { "at", alert.At } };
        }

        public static Task<object> Call(string method, object[] a)
        {
            switch (method)
            {
                case "setBatteryAlert":
                {
                    if (alert == null) return null;
                    var p = a != null && a.Length > 0 ? a[0] as Dictionary<string, object> : null;
                    int pct = battery; bool chg = charging, warn;
                    lock (gate)
                    {
                        bool on = p != null && p.TryGetValue("on", out var o) ? Convert.ToBoolean(o) : alert.On;
                        int at = p != null && p.TryGetValue("at", out var v) ? Convert.ToInt32(v) : alert.At;
                        alert.Set(on, at);
                        alert.Save();
                        warn = link != null && pct > 0 && alert.Check(pct, chg);
                    }
                    if (warn) Notify(pct, test: false);
                    return Task.FromResult<object>(null);
                }
                case "testBatteryAlert":
                {
                    if (alert == null) return null;
                    int pct = battery;
                    Notify(link != null && pct > 0 ? pct : alert.At, test: true);
                    return Task.FromResult<object>(null);
                }
                case "setStage":
                case "setActiveStage":
                case "setPolling":
                    // Monarch reaches the mouse's settings only through the dongle or the cable.
                    // Over Bluetooth a change would go to the idle dongle and be lost, so refuse it
                    // and put the page back to what the mouse really has.
                    if (link != "bluetooth") return null;
                    Host.Post(() => Host.UiEvent("mouse", Host.MouseState()));
                    return Task.FromResult<object>(new Dictionary<string, object>
                    {
                        { "ok", false },
                        { "message", "Over Bluetooth, Monarch can't change the mouse's settings. Switch it to the dongle or the cable first." },
                    });
                default:
                    return null;
            }
        }
    }
}
