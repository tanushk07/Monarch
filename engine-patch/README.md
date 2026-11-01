# Mouse battery and connection patch

Monarch 0.6.2 didn't read the mouse battery, and it reported "wireless, through the USB dongle"
whenever the dongle was plugged in, even with the mouse switched to Bluetooth. This folder adds
both, without access to Monarch's original source code.

## What changed in Monarch.exe

The exe at the top of the repository is the released 0.6.2 build with three one-line hooks
added. Decompiling it and comparing it with the original shows exactly these, and nothing else:

| Method | Added |
|---|---|
| `MouseDevice.Start()` | at the end: `Hooks.Started(this)` starts the battery watcher |
| `App.MouseState()` | returns `Hooks.State(dictionary, this)`: adds battery, charging, link and the warning setting |
| `App.Call(method, args)` | first: `Hooks.Call(this, method, args)`; if that returns a task, it is the answer |

Everything else (fans, lights, pump screen, wallpaper) is byte-for-byte the original code. The
new logic lives in `MonarchMouse.dll`, next to the exe. Every hook catches its own errors, so if
anything in the DLL fails, Monarch behaves exactly as 0.6.2 did.

## How the DLL works

**Which link the mouse is on.** The watcher needs evidence that the mouse itself is on a link,
not merely that the dongle is plugged in. It checks, in order:

1. the mouse's own USB device is present (cable): `wired`;
2. Windows reports the Bluetooth LE connection as up: `bluetooth`;
3. the mouse answers the battery request through the dongle: `dongle`.

If the dongle stops answering twice in a row (about 20 seconds), the mouse is asleep or off and
the page says so. A Bluetooth connect or disconnect triggers a new check at once; otherwise the
check runs every 30 seconds, or every 10 seconds while searching.

**The battery.** Through the dongle or the cable, the watcher sends the vendor report
`50 02 00 …` to interface 2 (the interface Monarch already uses for DPI) and reads
`51 02 PP CC SS`, where PP is the percent. It opens its own handle to that interface. Windows
gives each handle its own copy of every reply, so Monarch's reader is untouched, and the request
is written under Monarch's own write lock so it can't split a lighting command. Over Bluetooth,
the percent comes from the standard Battery Service, the same value Windows Settings shows.

Right after it connects over Bluetooth, the mouse reports 0% for up to a minute, until it has
measured its battery. A mouse that answers is never really at 0%, so 0 counts as "not measured
yet". The last real reading (from any link, up to 10 minutes old) stays on screen meanwhile,
and the watcher checks every 5 seconds until a real level arrives, or sooner if the mouse sends
one by itself. This also keeps that false 0% from setting off the low battery warning.

**Charging.** On the cable it always is, since USB powers the mouse. Over Bluetooth, the standard
Battery Service has no charging flag. The watcher first looks for the mouse's own battery report
over Bluetooth (which has one), and if the mouse doesn't offer it, shows "Charging" once the
level has risen two points (a few minutes after plugging in), until it stops rising for 5
minutes or drops. On the dongle the mouse's charging byte is used, with the same rising-level
check as a backup while that byte's meaning is unconfirmed.

**Bluetooth polling rate.** Over Bluetooth, the mouse sends its position each time the connection
exchanges data, so the rate is the connection's. Windows 11 reports the connection interval
(`BluetoothLEDevice.GetConnectionParameters()`), and the Mouse page shows the result, for
example 133 Hz for 7.5 ms. On Windows 10 it shows the typical range instead.

The request and the percent byte come from two Linux tools for this mouse,
[omarchy-hyperx-battery](https://github.com/Emanuel4100/omarchy-hyperx-battery) and
[waybar-hyperx-haste2](https://github.com/czQery/waybar-hyperx-haste2). Only one of them reads
the charging bytes CC and SS, so the first reply is written to Monarch's log
(`mouse+: battery reply on dongle: 51-02-…`) to confirm them on the real mouse.

**The warning.** The engine checks every reading against the level set on the Mouse page and
shows a Windows notification from the tray icon, so it works with the window closed. It warns
once, then re-arms when the mouse charges or the reading climbs 5 points above the level, so a
reading that jitters around the level doesn't warn over and over. The setting is saved in
`%AppData%\Monarch\mouse-battery.txt`.

**Over Bluetooth**, Monarch can't reach the mouse's settings (it only talks to the dongle and the
cable), so DPI and polling changes are refused with a message instead of going to the idle
dongle.

## Rebuilding

```bash
engine-patch/build.sh
```

This needs the .NET 8 SDK. It patches the unpatched exe from git history and writes
`Monarch.exe` and `MonarchMouse.dll` to the top of the repository. The patcher refuses an exe
that is already patched.

## Checking it on the PC

Logs: Settings > Open logs folder, lines starting with `mouse+:`.

1. Start Monarch with the mouse on the dongle. The log shows `battery reply on dongle: 51-02-…`
   and the Mouse page shows "2.4 GHz dongle" and the same percent as NGENUITY.
2. Switch the mouse to Bluetooth. The page changes to "Bluetooth" within a few seconds. The log
   lists the paired Bluetooth devices once. If the mouse's name isn't picked up, or the Battery
   Service can't be read, the log says why.
3. Plug in the cable: "USB cable", "Charging". Compare the logged bytes on the cable and on the
   dongle to confirm what bytes 3 and 4 mean.
4. Press Test next to the warning slider: a Windows notification appears. If not, check that
   Do not disturb is off.
