using System;

namespace MonarchMouse
{
    // Over Bluetooth the standard battery report has no charging flag, so charging is read from the
    // level itself: a battery only goes up while it charges. A rise of one point can be noise (the
    // reading recovers a little when the mouse rests), so it takes two points above the lowest
    // recent reading. A mouse charging from USB gains about a point a minute, so this shows within
    // a few minutes. Charging ends when the level drops, or after RiseWindow without another rise.
    internal sealed class RiseTracker
    {
        public static readonly TimeSpan RiseWindow = TimeSpan.FromMinutes(5);

        int low = -1, last = -1;
        DateTime rose = DateTime.MinValue;

        public void Reset() { low = last = -1; rose = DateTime.MinValue; }

        public bool Charging(DateTime now) => now - rose < RiseWindow;

        public void Add(int pct, DateTime now)
        {
            if (pct <= 0) return;
            if (last >= 0 && pct < last) { rose = DateTime.MinValue; low = pct; }   // dropping: on battery
            else if (low < 0 || pct < low) low = pct;
            else if (pct >= low + 2) { rose = now; low = pct; }                      // up two points: charging
            last = pct;
        }
    }
}
