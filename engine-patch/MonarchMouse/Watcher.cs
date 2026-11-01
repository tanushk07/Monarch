using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using HidSharp;

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
        static readonly TimeSpan Every = TimeSpan.FromSeconds(30);       // while everything is known
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
        static volatile string chargingFrom;  // "cable", "mouse" (its own report), "level" (it went up), or null
        static volatile int linkRate;         // reports a second over Bluetooth, 0 when unknown
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
        static void Run()
        {
            try { ble = new BleBattery(); ble.Changed += Poke; }
            catch (Exception ex) { ble = null; Host.Warn("Bluetooth unavailable: " + ex.Message); }

            var rise = new RiseTracker();
            HidDevice btVendor = null;
            bool btVendorChecked = false;
            int misses = 0, btVendorMisses = 0;
            var next = DateTime.MinValue;
            var levelAt = DateTime.MinValue;    // when lastLevel was read
            int lastLevel = -1;                 // the last real reading, on any link
            string lastLog = null;
            bool loggedRaw = false;
            while (true)
            {
                try
                {
                    if (DateTime.UtcNow >= next)
                    {
                        var t = DateTime.UtcNow;
                        string was = link;
                        string now = null;
                        Reading? r = null;      // the mouse's own battery report
                        int btLevel = -1;       // the Bluetooth Battery Service
                        int rate = 0;

                        var cable = UsbBattery.Find(UsbBattery.Cables);
                        if (cable != null)
                        {
                            now = "wired";
                            r = UsbBattery.Request(cable, Host.WriteGate(mouseDevice));
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
                                Host.Info(btVendor != null ? "Bluetooth: the mouse offers its battery report, charging included" : "Bluetooth: no battery report from the mouse itself; using the Battery Service");
                            }
                            if (btVendor != null)
                            {
                                r = UsbBattery.Request(btVendor, null);
                                if (r == null && ++btVendorMisses >= 3) { btVendor = null; Host.Info("Bluetooth: the mouse's battery report didn't answer; using the Battery Service"); }
                            }
                            if (r == null || r.Value.Percent == 0) btLevel = ble.ReadLevel() ?? -1;
                            rate = BluetoothRate();
                        }
                        else
                        {
                            var dongle = UsbBattery.Find(UsbBattery.Dongles);
                            if (dongle != null) r = UsbBattery.Request(dongle, Host.WriteGate(mouseDevice));
                            if (r != null) { now = "dongle"; misses = 0; }
                            // one missed reply isn't sleep yet
                            else if (dongle != null && was == "dongle" && ++misses < MissesBeforeAsleep) now = "dongle";
                        }
                        if (now != "dongle") misses = 0;
                        if (r != null && !loggedRaw) { loggedRaw = true; Host.Info("battery reply on " + now + ": " + r.Value.Raw); }

                        // The level: a real reading wins. 0 is never real: a mouse that answers isn't
                        // empty, it just hasn't measured yet. Without a reading the last one stands
                        // for a while, also across a switch of link, so switching to Bluetooth
                        // doesn't blank the level while the mouse measures.
                        int fresh = r != null && r.Value.Percent > 0 ? r.Value.Percent : btLevel > 0 ? btLevel : -1;
                        if (fresh > 0) { lastLevel = fresh; levelAt = t; }
                        int pct = fresh > 0 ? fresh : now != null && lastLevel > 0 && t - levelAt < KeepLevel ? lastLevel : -1;

                        // Charging: on the cable it always is (USB powers the mouse). On a wireless
                        // link, when the mouse's own report says so, or when the level is going up:
                        // the Bluetooth Battery Service has no charging flag, and the report's
                        // charging byte is still unconfirmed on this mouse.
                        if (now != was) rise.Reset();
                        if (fresh > 0 && now != "wired") rise.Add(fresh, t);
                        bool chg; string from = null;
                        if (now == "wired") { chg = true; from = "cable"; }
                        else if (now == "dongle" && r == null) { chg = charging; from = chargingFrom; }   // a missed reply: keep what we had
                        else if (r != null && r.Value.Charging) { chg = true; from = "mouse"; }
                        else if (now != null && rise.Charging(t)) { chg = true; from = "level"; }
                        else chg = false;

                        Update(now, pct, chg, from, rate);

                        // log the link, the charge state and each 10% step, not every reading
                        string key = (now ?? "not connected") + (pct > 0 ? ", about " + (pct / 10 * 10) + "%" : "") + (chg ? ", charging" : "") + (rate > 0 ? ", " + rate + " Hz" : "");
                        if (key != lastLog) { lastLog = key; Host.Info((now ?? "not connected") + (pct > 0 ? ", " + pct + "%" : "") + (chg ? ", charging (" + from + ")" : "") + (rate > 0 ? ", Bluetooth link " + rate + " Hz" : "")); }

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
                if (woken) { woken = false; next = DateTime.MinValue; }
            }
        }

        static bool BluetoothUp()
        {
            try { return ble != null && ble.Connected; }
            catch (Exception ex) { Host.Warn("Bluetooth: " + ex.Message); return false; }
        }

        // Reports a second the Bluetooth link allows (one per connection interval), or 0 when
        // Windows doesn't say (Windows 10).
        static bool loggedNoRate;
        static int BluetoothRate()
        {
            try
            {
                double? ms = ble.IntervalMs();
                return ms > 0 ? (int)Math.Round(1000.0 / ms.Value) : 0;
            }
            catch (Exception ex)
            {
                if (!loggedNoRate) { loggedNoRate = true; Host.Info("Bluetooth link rate unavailable: " + ex.GetType().Name); }
                return 0;
            }
        }

        // Asks for a check now instead of at the next interval (Bluetooth came up or went down, or
        // the mouse sent a new level).
        static void Poke() { woken = true; wake.Set(); }

        static void Update(string now, int pct, bool chg, string from, int rate)
        {
            bool changed = now != link || pct != battery || chg != charging || from != chargingFrom || rate != linkRate || !polled;
            link = now; battery = pct; charging = chg; chargingFrom = from; linkRate = rate; polled = true;
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
            int pct = battery, rate = linkRate;
            d["connected"] = l != null;
            d["wireless"] = l != null && l != "wired";
            d["connection"] = l;
            d["battery"] = l != null && pct > 0 ? (object)pct : null;
            d["charging"] = l != null && charging;
            d["chargingFrom"] = l != null && charging ? chargingFrom : null;
            d["linkRate"] = l == "bluetooth" && rate > 0 ? (object)rate : null;
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
