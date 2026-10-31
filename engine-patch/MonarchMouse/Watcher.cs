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
        static readonly TimeSpan Every = TimeSpan.FromSeconds(30);       // battery and link, while connected
        static readonly TimeSpan Searching = TimeSpan.FromSeconds(10);   // while the mouse isn't answering
        const int MissesBeforeAsleep = 2;

        static readonly object gate = new object();
        static readonly AutoResetEvent wake = new AutoResetEvent(false);
        static Thread thread;
        static object mouseDevice;
        static BleBattery ble;
        static BatteryAlert alert;

        // Written by the watcher thread, read on the UI thread.
        static volatile string link;          // "wired", "bluetooth", "dongle", or null
        static volatile int battery = -1;     // -1 until read
        static volatile bool charging;
        static volatile bool polled;          // false until the first check finishes
        static volatile bool dirty;           // the page hasn't seen the latest values

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

            int misses = 0;
            var next = DateTime.MinValue;
            string lastLog = null;
            bool loggedRaw = false;
            while (true)
            {
                try
                {
                    if (DateTime.UtcNow >= next)
                    {
                        string was = link;
                        string now = null;
                        Reading? r = null;
                        int level = -1;

                        var cable = UsbBattery.Find(UsbBattery.Cables);
                        if (cable != null)
                        {
                            now = "wired";
                            r = UsbBattery.Request(cable, Host.WriteGate(mouseDevice));
                        }
                        else if (BluetoothUp())
                        {
                            now = "bluetooth";
                            level = ble.ReadLevel() ?? -1;
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

                        // A reading wins; without one, keep the last value while the link stays the same.
                        int pct = r?.Percent ?? (level >= 0 ? level : now != null && now == was ? battery : -1);
                        bool chg = now == "wired" ? (r?.Charging ?? true)
                                 : now == "dongle" ? (r?.Charging ?? (was == "dongle" && charging))
                                 : false;
                        if (r != null && !loggedRaw) { loggedRaw = true; Host.Info("battery reply on " + now + ": " + r.Value.Raw); }

                        Update(now, pct, chg);

                        // log the link, the charge state and each 10% step, not every reading
                        string key = (now ?? "not connected") + (pct >= 0 ? ", about " + (pct / 10 * 10) + "%" : "") + (chg ? ", charging" : "");
                        if (key != lastLog) { lastLog = key; Host.Info((now ?? "not connected") + (pct >= 0 ? ", " + pct + "%" : "") + (chg ? ", charging" : "")); }

                        next = DateTime.UtcNow + (now == null || misses > 0 ? Searching : Every);
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
        static volatile bool woken;

        static bool BluetoothUp()
        {
            try { return ble != null && ble.Connected; }
            catch (Exception ex) { Host.Warn("Bluetooth: " + ex.Message); return false; }
        }

        // Asks for a check now instead of at the next interval (Bluetooth came up or went down).
        static void Poke() { woken = true; wake.Set(); }

        static void Update(string now, int pct, bool chg)
        {
            bool changed = now != link || pct != battery || chg != charging || !polled;
            link = now; battery = pct; charging = chg; polled = true;
            if (changed) dirty = true;
            if (now != null && pct >= 0)
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
            d["battery"] = l != null && pct >= 0 ? (object)pct : null;
            d["charging"] = l != null && charging;
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
                        warn = link != null && pct >= 0 && alert.Check(pct, chg);
                    }
                    if (warn) Notify(pct, test: false);
                    return Task.FromResult<object>(null);
                }
                case "testBatteryAlert":
                {
                    if (alert == null) return null;
                    int pct = battery;
                    Notify(link != null && pct >= 0 ? pct : alert.At, test: true);
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
