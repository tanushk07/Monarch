using System;
using System.Collections.Generic;
using System.Threading;
using Windows.Devices.Bluetooth;
using Windows.Devices.Bluetooth.GenericAttributeProfile;
using Windows.Devices.Enumeration;
using Windows.Foundation;
using Windows.Storage.Streams;

namespace MonarchMouse
{
    // The mouse over Bluetooth, through Windows' Bluetooth API (Windows 10 and 11).
    //
    // Windows keeps a paired mouse in its list while it is off or on the dongle, so "paired" says
    // nothing. What counts is ConnectionStatus. The battery comes from the standard Bluetooth
    // Battery Service (0x180F, Battery Level 0x2A19), the same value Windows Settings shows. That
    // service carries the percent only, not whether the mouse is charging.
    internal sealed class BleBattery
    {
        BluetoothLEDevice dev;
        string devId;
        GattCharacteristic level;
        bool notifyTried;
        DateTime nextScan = DateTime.MinValue;
        bool loggedNames, loggedService, loggedZero;

        // Raised (on a Windows thread) when the link comes up or goes down, or the mouse sends a
        // new battery level.
        public event Action Changed;

        public bool Connected
        {
            get
            {
                if (DateTime.UtcNow >= nextScan) Scan();
                return dev != null && dev.ConnectionStatus == BluetoothConnectionStatus.Connected;
            }
        }

        public string Name => dev?.Name;

        // Finds the paired HyperX mouse. Repeated every 10 minutes, or every minute until one is found.
        void Scan()
        {
            try
            {
                var found = new List<string>();
                DeviceInformation pick = null;
                foreach (DeviceInformation info in Wait(DeviceInformation.FindAllAsync(BluetoothLEDevice.GetDeviceSelectorFromPairingState(true))))
                {
                    string n = info.Name ?? "";
                    found.Add(n);
                    if (pick == null && (Has(n, "HyperX") || Has(n, "Pulsefire") || Has(n, "Haste"))) pick = info;
                }
                if (!loggedNames) { loggedNames = true; Host.Info("paired Bluetooth LE devices: " + (found.Count == 0 ? "none" : string.Join(", ", found))); }
                if (pick != null && pick.Id != devId)
                {
                    Drop();
                    dev = Wait(BluetoothLEDevice.FromIdAsync(pick.Id));
                    devId = pick.Id;
                    if (dev != null)
                    {
                        dev.ConnectionStatusChanged += OnStatus;
                        Host.Info("Bluetooth mouse: " + dev.Name + ", " + dev.ConnectionStatus);
                    }
                }
                nextScan = DateTime.UtcNow + (dev == null ? TimeSpan.FromMinutes(1) : TimeSpan.FromMinutes(10));
            }
            catch (Exception ex)
            {
                Host.Warn("Bluetooth scan: " + ex.Message);
                nextScan = DateTime.UtcNow + TimeSpan.FromMinutes(1);
            }
        }

        // Runs on a Windows thread: it only asks the watcher thread to check again. If the battery
        // handle went stale over the reconnect, the next read fails, drops it and fetches a new one.
        void OnStatus(BluetoothLEDevice sender, object args)
        {
            try { Changed?.Invoke(); } catch { }
        }

        // 1-100, or null when there is no real reading yet.
        public int? ReadLevel()
        {
            if (dev == null || dev.ConnectionStatus != BluetoothConnectionStatus.Connected) return null;
            try
            {
                if (level == null)
                {
                    var services = Wait(dev.GetGattServicesForUuidAsync(GattServiceUuids.Battery, BluetoothCacheMode.Cached));
                    if (services.Status != GattCommunicationStatus.Success || services.Services.Count == 0)
                    { LogService("Battery Service: " + services.Status + ", " + services.Services.Count + " found"); return null; }
                    var chars = Wait(services.Services[0].GetCharacteristicsForUuidAsync(GattCharacteristicUuids.BatteryLevel, BluetoothCacheMode.Cached));
                    if (chars.Status != GattCommunicationStatus.Success || chars.Characteristics.Count == 0)
                    { LogService("Battery Level: " + chars.Status + ", " + chars.Characteristics.Count + " found"); return null; }
                    level = chars.Characteristics[0];
                }
                if (!notifyTried) Subscribe();
                var read = Wait(level.ReadValueAsync(BluetoothCacheMode.Uncached));
                if (read.Status != GattCommunicationStatus.Success) { LogService("read: " + read.Status); ForgetLevel(); return null; }
                var reader = DataReader.FromBuffer(read.Value);
                if (reader.UnconsumedBufferLength < 1) return null;
                int pct = reader.ReadByte();
                // Right after it connects, the mouse reports 0% until it has measured its battery.
                // A connected mouse is never really at 0%, so 0 means "not measured yet".
                if (pct == 0)
                {
                    if (!loggedZero) { loggedZero = true; Host.Info("Bluetooth battery reads 0% right after connecting; waiting for a real level"); }
                    return null;
                }
                return pct <= 100 ? pct : (int?)null;
            }
            catch (Exception ex)
            {
                LogService("battery: " + ex.Message);
                ForgetLevel();
                return null;
            }
        }

        // Asks the mouse to send new battery levels as they change, so a new level shows at once
        // instead of at the next check. Tried once per connection; checking on a timer still works
        // if the mouse doesn't offer it.
        void Subscribe()
        {
            notifyTried = true;
            try
            {
                if ((level.CharacteristicProperties & GattCharacteristicProperties.Notify) == 0) { Host.Info("Bluetooth battery: the mouse doesn't send updates by itself"); return; }
                var status = Wait(level.WriteClientCharacteristicConfigurationDescriptorAsync(GattClientCharacteristicConfigurationDescriptorValue.Notify));
                if (status == GattCommunicationStatus.Success) { level.ValueChanged += OnLevel; Host.Info("Bluetooth battery: updates from the mouse on"); }
                else Host.Info("Bluetooth battery updates: " + status);
            }
            catch (Exception ex) { Host.Info("Bluetooth battery updates: " + ex.Message); }
        }

        void OnLevel(GattCharacteristic sender, GattValueChangedEventArgs args)
        {
            try { Changed?.Invoke(); } catch { }
        }

        // The Bluetooth connection interval in milliseconds: how often the link exchanges data, which
        // sets how often a Bluetooth mouse can send its position. Windows 11 only; on Windows 10 the
        // call fails and the caller treats that as unknown.
        public double? IntervalMs()
        {
            if (dev == null || dev.ConnectionStatus != BluetoothConnectionStatus.Connected) return null;
            var p = dev.GetConnectionParameters();
            return p == null || p.ConnectionInterval == 0 ? (double?)null : p.ConnectionInterval * 1.25;
        }

        void ForgetLevel()
        {
            try { if (level != null && notifyTried) level.ValueChanged -= OnLevel; } catch { }
            level = null;
            notifyTried = false;
        }

        void LogService(string msg) { if (!loggedService) { loggedService = true; Host.Warn("Bluetooth " + msg); } }

        void Drop()
        {
            ForgetLevel();
            try { if (dev != null) { dev.ConnectionStatusChanged -= OnStatus; dev.Dispose(); } } catch { }
            dev = null; devId = null;
        }

        static bool Has(string s, string part) => s.IndexOf(part, StringComparison.OrdinalIgnoreCase) >= 0;

        // Waits for a Windows async call without .NET's await adapters. The callback may arrive
        // after a timeout, on a Windows thread, so it must never throw.
        static T Wait<T>(IAsyncOperation<T> op, int ms = 5000)
        {
            var done = new ManualResetEvent(false);
            op.Completed = (o, s) => { try { done.Set(); } catch { } };
            if (!done.WaitOne(ms)) { try { op.Cancel(); } catch { } throw new TimeoutException("Windows didn't answer in time"); }
            return op.GetResults();
        }
    }
}
