MONARCH 0.6.2, one app for your lights, fans, pump screen, mouse and wallpaper

NEW IN 0.6.2
- Starts with Windows, not just at sign-in: a small boot helper (Task Scheduler, as SYSTEM, no
  window) runs your fan curves and puts the motherboard lights back to your last colours from the
  moment Windows starts. At sign-in Monarch opens right away (no delay, normal priority) and takes
  the devices over from the helper. The startup tasks also no longer stop after 72 hours.
- Settings > Other apps checks what is really installed. Folders, files and uninstall entries an
  app leaves behind no longer count, so uninstalled apps don't show up.
- Rename any part from Lighting > Layout: the pencil in the parts list or the selection card, or
  click a part that's already picked. Enter saves, Esc cancels.
- The pump screen preview gets every frame the pump gets while the Pump screen page is open, so
  it moves as smoothly as the pump.

NEW IN 0.6.1
- Monarch now shows only what this PC has: pages, devices, readings and other apps appear
  when the hardware or app is really there. On a PC without a pump screen or this mouse,
  those pages don't show.
- The made-up "Radiator 1-3" and "Side 1-2" parts from the first versions are gone. Each
  ARGB header they sat on is one line with the same LEDs until you run Find fans on it.
- The Rig page draws what is on your Layout, where you put it.
- Alienware monitor lights (logo, size number, power button) through the monitor's USB
  upstream cable. They take one colour from the monitor's box on the Layout tab. Close
  Alienware Command Center, or it takes them back.
- Boot animation and standby picture each have their own fit, zoom, position and
  background, with a live round preview.
- Each reading on the pump screen has a hide button.
- Settings > Other apps lists only apps that are installed here and can take over something
  Monarch drives (SignalRGB, OpenRGB, TT RGB Plus, NGENUITY, Gigabyte, ASUS, MSI, iCUE,
  FanControl, Alienware Command Center, Lively, Wallpaper Engine).
- A fan header can be marked as a pump (never below 40%), instead of being known by its name.
- Without a coolant sensor, fan curves follow the CPU and the Status window shows the CPU.

NEW IN 0.6.0
- New look: the System's window over your rig. The accent colour follows your lights.
  Coolant, CPU and GPU temperatures sit in the title bar on every page.
- Pump screen: live frames are kept under 20 KB, the most the pump accepts. Busy videos
  (like Firefly) made bigger frames and the pump kept dropping back to its standby picture.
- Videos are read in slices instead of whole, so big clips no longer cost their full size
  in memory on every read.
- Readings on top only shows for pictures, videos, mirrors and the effect.
- The wallpaper no longer flips between paused and playing while you alt-tab a game.
- Smoother: pages that changed in the background redraw when you open them, live numbers
  update in place, and the accent colour updates a few times a second instead of every frame.

INSTALL
1. Extract this folder somewhere permanent, for example C:\Monarch
   (not Downloads: Windows starts Monarch from wherever it lives).
2. Run Monarch.exe. Windows asks for admin once. Fan control needs it.
   If SmartScreen says "Windows protected your PC", click More info, then Run anyway.
3. On start Monarch closes other apps that can take over the devices it drives here
   (Settings > Other apps lists them). Turn that off in Settings if you don't want it.
4. Cooling page: click Install PawnIO once. It's the driver FanControl and
   LibreHardwareMonitor use to talk to the fan chip. The RAM lights need it too.

After that fans and the board's lights follow Monarch from Windows start, Monarch itself opens
at sign-in, elevated, without a prompt, and lives in the tray. Click the tray icon to open it.

WHAT IT CAN DRIVE (each shows up only when it's found)
- Screen ambience  lights follow your monitor (display, frame rate and area in Lighting > Layout)
- Pump screen (Thermaltake TH V2 Ultra)  vitals, system info, clock, pictures/GIF/video,
  the lighting effect; plus a boot animation and standby picture saved on the pump
- Colorful iGame graphics cards  one colour, taken from the middle of its box on the Layout
- Memory with ENE light controllers  each stick follows its own box on the Layout (needs PawnIO)
- Alienware monitors  logo, size number and power button, one colour (USB upstream cable needed)
  Lighting only lists devices that actually answer. The graphics card and memory show up
  once they reply; their parts appear on the Layout tab then.
- Motherboard RGB (Gigabyte IT5711)  the three ARGB headers and onboard zones
- Fan headers  curves from coolant, CPU or GPU temperature. "Find it" runs one header at
  full speed for 6 seconds so you can see which fans it drives. Most PWM fans can't stop
  at 0% (they idle at their lowest speed); to let a header stop its fans, set it to
  Voltage mode in the BIOS (Smart Fan 6). The pump never goes below 40%.
- HyperX Pulsefire Haste 2  DPI stages, polling rate, logo light
- Live wallpapers  videos, GIFs, pictures and HTML wallpapers behind the desktop icons

LIGHTING (one section, three tabs)
- Effects  library, live preview, settings, playlist, overall brightness,
  Import, Bring over SignalRGB effects, Match my wallpaper
- Layout   the effect canvas with a box per part. Drag, resize (width and height
  separately; hold Shift to keep the shape), rotate, mirror,
  hide; select several and move/resize them together; undo/redo. Several saved
  layouts, each with its own brightness, and a layout can load by itself with an
  effect. The Screen card sets which display ambience watches and which part of it.
  "Test with a sweep" checks that light travels through your parts in order.
  A selected part is drawn on top, so you can grab it even under a bigger box.
- Devices  everything found, per-device brightness and off switch, the fans and
  strips on each ARGB header (add, remove, LED count, order, reversed), the mouse
  logo light, and when lights go dark (sleep, shutdown, displays off, lock)
- Layout: "Effect behind" slider sets how strongly the effect shows behind the parts.

SCREEN AMBIENCE TIPS
- Games: borderless or fullscreen both work. If Lighting > Layout > Screen says
  "the old way", tell Claude what the message in brackets says.
- HDR on: Monarch asks Windows for an SDR copy, so it should still work.

FIND FANS (do this first)
Plain ARGB headers can't tell Monarch what is plugged in or how many LEDs each fan has.
Lighting > Devices > a header > Find fans: drag the slider until the first fan is fully
white, press "That's the first fan", repeat for each fan, then Save. If every fan on a
header lights up at once, they share one signal (splitter or hub): tick that box and
mark one fan. Then place the new parts on the Layout tab.

PUMP SCREEN
- Picture or video: Fit (fill, whole picture, stretch), zoom, move, background colour.
  GIFs and animated WebP play.
- Readings on top: add any reading (temps, loads, clocks, time, date...), drag it on the
  preview, pick its size and colour. Works over pictures, videos, mirrors and the effect.
- Screen mirror: any part of a display, live. Window: one app's window, even when other
  windows cover it (Windows' own window capture, like OBS uses).
- System info: pick up to six readings (CPU/GPU temps, load, clocks, power, RAM speed...).
- Saved on the pump: the boot animation (a GIF works) and the standby picture live inside
  the pump, like TT RGB Plus does it. The standby slot holds one still picture, so a GIF
  there keeps its first frame. They show while the PC boots and whenever
  Monarch isn't driving the screen. Saving takes a minute; keep Monarch open.

WALLPAPER (Lively no longer needed)
- Monarch plays wallpapers itself: videos, GIFs and pictures in mpv (the same player
  Lively uses, in tools\mpv), HTML wallpapers in a browser view. It pauses while a game
  or app is fullscreen, and while the PC is locked or the screen is off.
- "Bring them over" copies your Lively library and takes over the wallpaper Lively was
  showing. After that you can uninstall Lively.

NOT YET
- Mouse battery level, sleep timer, button remaps (need a USB capture first)

SETTING UP THE LIGHTS
Lighting > Devices: check each header lists what is really plugged into it.
Press the bulb to flash one part white and check it is the right one.
Then Lighting > Layout: put each part where it sits relative to your screen.

UNINSTALL
Settings > turn off Start with Windows (removes the three scheduled tasks),
quit from the tray, delete the folder and %AppData%\Monarch.

Logs: Settings > Open logs folder.
