# Makes a FlowCut shortcut with the FlowCut icon. It opens the app directly: no command window.
# usage: powershell -ExecutionPolicy Bypass -File build\create-shortcut.ps1 [-Folder <where>]
#        default folder: the FlowCut folder itself (drag FlowCut.lnk to the desktop, or right-click > Pin to taskbar)
#        -Folder Desktop puts it straight on the desktop. Run it again after moving the FlowCut folder.
param([string]$Folder = '')
$root = Split-Path -Parent $PSScriptRoot
$electron = Join-Path $root 'node_modules\electron\dist\electron.exe'
if (-not (Test-Path $electron)) { throw "Electron is missing: run npm install in $root first." }
if ($Folder -eq 'Desktop') { $Folder = [Environment]::GetFolderPath('Desktop') }
if (-not $Folder) { $Folder = $root }
$link = Join-Path $Folder 'FlowCut.lnk'
$shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut($link)
$shortcut.TargetPath = $electron
$shortcut.Arguments = '"' + $root + '"'
$shortcut.WorkingDirectory = $root
$shortcut.IconLocation = (Join-Path $root 'build\icon.ico') + ',0'
$shortcut.Description = 'FlowCut: cut silences and filler words, review, render'
$shortcut.WindowStyle = 1
$shortcut.Save()

# Windows shows a pinned shortcut and the running window as one taskbar button only when both carry the same
# app id; src/main/main.js sets it on the window (setAppUserModelId). WScript.Shell cannot set it, the shell can.
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class FlowCutLink {
  [StructLayout(LayoutKind.Sequential, Pack = 4)]
  struct PropertyKey { public Guid fmtid; public uint pid; }
  [StructLayout(LayoutKind.Sequential)]
  struct PropVariant { public ushort vt; public ushort r1; public ushort r2; public ushort r3; public IntPtr p; public IntPtr p2; }
  [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IPropertyStore {
    void GetCount(out uint count);
    void GetAt(uint index, out PropertyKey key);
    void GetValue(ref PropertyKey key, out PropVariant value);
    void SetValue(ref PropertyKey key, ref PropVariant value);
    void Commit();
  }
  [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
  static extern void SHGetPropertyStoreFromParsingName(string path, IntPtr bindCtx, int flags, ref Guid iid,
    [MarshalAs(UnmanagedType.Interface)] out IPropertyStore store);
  public static void SetAppId(string lnk, string appId) {
    Guid iid = typeof(IPropertyStore).GUID;
    IPropertyStore store;
    SHGetPropertyStoreFromParsingName(lnk, IntPtr.Zero, 2 /* GPS_READWRITE */, ref iid, out store);
    // PKEY_AppUserModel_ID, as a VT_LPWSTR string
    PropertyKey key = new PropertyKey { fmtid = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), pid = 5 };
    PropVariant value = new PropVariant { vt = 31, p = Marshal.StringToCoTaskMemUni(appId) };
    try { store.SetValue(ref key, ref value); store.Commit(); }
    finally { Marshal.FreeCoTaskMem(value.p); Marshal.ReleaseComObject(store); }
  }
}
'@
try { [FlowCutLink]::SetAppId($link, 'ai.flowbyte.flowcut') }
catch { Write-Warning "Shortcut made, but its taskbar id was not set (pinning may show two buttons): $($_.Exception.Message)" }
Write-Output $link
