using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Windows.Forms;

namespace MonarchMouse
{
    // Reaches the parts of Monarch this library needs (its log, the page, the tray icon) by name,
    // through reflection, so Monarch.exe itself only needs three one-line hooks. A member that
    // can't be found makes that one feature quietly unavailable; it never stops Monarch.
    internal static class Host
    {
        const BindingFlags Any = BindingFlags.Instance | BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic;

        static Assembly monarch;
        static object app;

        public static void Remember(object appInstance) { if (appInstance != null) { app = appInstance; monarch = appInstance.GetType().Assembly; } }
        public static void RememberAssembly(Assembly a) { if (monarch == null) monarch = a; }

        static Type T(string name) => (monarch ?? Assembly.GetEntryAssembly())?.GetType("Monarch." + name);

        static object App
        {
            get
            {
                if (app == null) app = T("App")?.GetField("I", Any)?.GetValue(null);
                return app;
            }
        }

        // ---------------------------------------------------------------- log
        public static void Info(string msg) => Log("Info", msg);
        public static void Warn(string msg) => Log("Warn", msg);
        static void Log(string level, string msg)
        {
            try { T("Log")?.GetMethod(level, Any, null, new[] { typeof(string) }, null)?.Invoke(null, new object[] { "mouse+: " + msg }); }
            catch { }
        }

        // Monarch's data folder (%AppData%\Monarch unless MONARCH_DATA says otherwise).
        public static string DataDir
        {
            get
            {
                try { if (T("Paths")?.GetField("Data", Any)?.GetValue(null) is string d) return d; } catch { }
                return Environment.GetEnvironmentVariable("MONARCH_DATA")
                    ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "Monarch");
            }
        }

        // ---------------------------------------------------------------- UI thread
        // Runs a on Monarch's UI thread. Everything below this point must only be called from there.
        public static bool Post(Action a)
        {
            var target = App;
            var post = T("App")?.GetMethod("Post", Any, null, new[] { typeof(Action) }, null);
            if (target == null || post == null) return false;
            post.Invoke(target, new object[] { (Action)(() => { try { a(); } catch (Exception ex) { Warn("ui: " + ex.Message); } }) });
            return true;
        }

        // True when the page is loaded and its window is on screen: only then does Monarch pass
        // live updates to it.
        public static bool PageVisible()
        {
            var t = T("App"); var target = App;
            if (t == null || target == null) return false;
            bool ready = t.GetField("uiReady", Any)?.GetValue(target) is bool r && r;
            bool showing = t.GetProperty("UiShowing", Any)?.GetValue(target) is bool s && s;
            return ready && showing;
        }

        public static void UiEvent(string name, object data)
        {
            var target = App;
            T("App")?.GetMethod("UiEvent", Any, null, new[] { typeof(string), typeof(object) }, null)?.Invoke(target, new[] { name, data });
        }

        // App.MouseState(), which runs the State hook, so the result includes the battery.
        public static Dictionary<string, object> MouseState()
        {
            var target = App;
            return T("App")?.GetMethod("MouseState", Any, null, Type.EmptyTypes, null)?.Invoke(target, null) as Dictionary<string, object>;
        }

        public static NotifyIcon Tray() => T("App")?.GetField("tray", Any)?.GetValue(App) as NotifyIcon;

        // ---------------------------------------------------------------- the engine's mouse
        // The lock Monarch holds while it writes to the mouse. Holding it for the battery request
        // keeps that request from landing between the two halves of a lighting command.
        public static object WriteGate(object mouseDevice) =>
            mouseDevice?.GetType().GetField("writeGate", Any)?.GetValue(mouseDevice);

        public static string Model(object mouseDevice) =>
            mouseDevice?.GetType().GetField("Model", Any)?.GetValue(mouseDevice) as string;
    }
}
