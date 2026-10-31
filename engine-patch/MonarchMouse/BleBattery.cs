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
    // Battery Service (0x180F, Battery Level 0x2A19), the same value Windows Settings shows.
    internal sealed class BleBattery
    {
        BluetoothLEDevice dev;
        string devId;
        GattCharacteristic level;
        DateTime nextScan = DateTime.MinValue;
        bool loggedNames, loggedService;

        // Raised (on a Windows thread) when the Bluetooth link comes up or goes down.
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

        void OnStatus(BluetoothLEDevice sender, object args)
        {
            try
            {
                if (sender.ConnectionStatus != BluetoothConnectionStatus.Connected) level = null;
                Changed?.Invoke();
            }
            catch { }
        }

        // 0-100, or null when the Battery Service can't be read.
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
                var read = Wait(level.ReadValueAsync(BluetoothCacheMode.Uncached));
                if (read.Status != GattCommunicationStatus.Success) { LogService("read: " + read.Status); level = null; return null; }
                var reader = DataReader.FromBuffer(read.Value);
                if (reader.UnconsumedBufferLength < 1) return null;
                int pct = reader.ReadByte();
                return pct <= 100 ? pct : (int?)null;
            }
            catch (Exception ex)
            {
                LogService("battery: " + ex.Message);
                level = null;
                return null;
            }
        }

        void LogService(string msg) { if (!loggedService) { loggedService = true; Host.Warn("Bluetooth " + msg); } }

        void Drop()
        {
            try { if (dev != null) { dev.ConnectionStatusChanged -= OnStatus; dev.Dispose(); } } catch { }
            dev = null; devId = null; level = null;
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
