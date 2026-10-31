using System;
using System.Collections.Generic;
using System.Threading.Tasks;

namespace MonarchMouse
{
    // The three entry points the patched Monarch.exe calls. Each one catches everything: whatever
    // goes wrong in here, Monarch keeps running exactly as it did before the patch.
    public static class Hooks
    {
        // Called at the end of MouseDevice.Start(), once, when Monarch starts its mouse code.
        public static void Started(object mouseDevice)
        {
            try { Watcher.Start(mouseDevice); }
            catch (Exception ex) { Host.Warn("start failed: " + ex); }
        }

        // Called with the dictionary App.MouseState() is about to send to the page.
        public static Dictionary<string, object> State(Dictionary<string, object> state, object app)
        {
            try { Host.Remember(app); Watcher.Decorate(state); }
            catch (Exception ex) { Host.Warn("state failed: " + ex.Message); }
            return state;
        }

        // Called first thing in App.Call(method, args). A task means the call was handled here;
        // null lets Monarch handle it as before.
        public static Task<object> Call(object app, string method, object[] args)
        {
            try { Host.Remember(app); return Watcher.Call(method, args); }
            catch (Exception ex) { Host.Warn("call " + method + " failed: " + ex.Message); return null; }
        }
    }
}
