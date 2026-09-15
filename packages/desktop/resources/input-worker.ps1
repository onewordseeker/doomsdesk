# Windows input injection worker — reads JSON from stdin, injects via user32.dll
# Stays alive; main process communicates via stdin pipe

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class U32 {
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern void mouse_event(int f, int x, int y, int d, int e);
    [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte sc, int f, int e);
    [DllImport("user32.dll")] public static extern int GetSystemMetrics(int n);
    public static int SW = GetSystemMetrics(0);
    public static int SH = GetSystemMetrics(1);
}
public class Disp {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Ansi)]
    public struct DEVMODE {
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmDeviceName;
        public short dmSpecVersion, dmDriverVersion, dmSize, dmDriverExtra;
        public int dmFields, dmPositionX, dmPositionY, dmDisplayOrientation, dmDisplayFixedOutput;
        public short dmColor, dmDuplex, dmYResolution, dmTTOption, dmCollate;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmFormName;
        public short dmLogPixels;
        public int dmBitsPerPel, dmPelsWidth, dmPelsHeight, dmDisplayFlags, dmDisplayFrequency;
        public int dmICMMethod, dmICMIntent, dmMediaType, dmDitherType, dmReserved1, dmReserved2, dmPanningWidth, dmPanningHeight;
    }
    [DllImport("user32.dll", CharSet = CharSet.Ansi)]
    public static extern int ChangeDisplaySettings(ref DEVMODE dm, int flags);
    [DllImport("user32.dll", CharSet = CharSet.Ansi)]
    public static extern bool EnumDisplaySettings(string device, int mode, ref DEVMODE dm);
}
"@

Write-Host "READY"
[Console]::Out.Flush()

$VK = @{
    'Backspace'=8;'Tab'=9;'Enter'=13;'Shift'=16;'Control'=17;'Alt'=18;
    'CapsLock'=20;'Escape'=27;' '=32;'PageUp'=33;'PageDown'=34;
    'End'=35;'Home'=36;'ArrowLeft'=37;'ArrowUp'=38;'ArrowRight'=39;'ArrowDown'=40;
    'Delete'=46;'Meta'=91;
    'F1'=112;'F2'=113;'F3'=114;'F4'=115;'F5'=116;'F6'=117;
    'F7'=118;'F8'=119;'F9'=120;'F10'=121;'F11'=122;'F12'=123;
}

while ($true) {
    $line = [Console]::ReadLine()
    if ($null -eq $line) { break }
    $line = $line.Trim()
    if ($line -eq '') { continue }
    try {
        $e  = $line | ConvertFrom-Json
        $t   = $e.type
        $x   = if ($null -ne $e.x) { [int]$e.x } else { 0 }
        $y   = if ($null -ne $e.y) { [int]$e.y } else { 0 }
        $btn = if ($e.button) { $e.button } else { 'left' }
        $m   = $e.modifiers

        switch ($t) {
            'mousemove' {
                [U32]::SetCursorPos($x, $y)
            }
            'mousedown' {
                [U32]::SetCursorPos($x, $y)
                if ($btn -eq 'right')  { [U32]::mouse_event(0x0008,0,0,0,0) }
                elseif ($btn -eq 'middle') { [U32]::mouse_event(0x0020,0,0,0,0) }
                else                   { [U32]::mouse_event(0x0002,0,0,0,0) }
            }
            'mouseup' {
                if ($btn -eq 'right')  { [U32]::mouse_event(0x0010,0,0,0,0) }
                elseif ($btn -eq 'middle') { [U32]::mouse_event(0x0040,0,0,0,0) }
                else                   { [U32]::mouse_event(0x0004,0,0,0,0) }
            }
            'click' {
                [U32]::SetCursorPos($x, $y)
                if ($btn -eq 'right')  { [U32]::mouse_event(0x0008,0,0,0,0); [U32]::mouse_event(0x0010,0,0,0,0) }
                elseif ($btn -eq 'middle') { [U32]::mouse_event(0x0020,0,0,0,0); [U32]::mouse_event(0x0040,0,0,0,0) }
                else                   { [U32]::mouse_event(0x0002,0,0,0,0); [U32]::mouse_event(0x0004,0,0,0,0) }
            }
            'wheel' {
                $delta = [int](-$e.deltaY * 3)
                [U32]::mouse_event(0x0800, 0, 0, $delta, 0)
            }
            'keydown' {
                if ($m -and $m.ctrl)  { [U32]::keybd_event(17, 0, 0, 0) }
                if ($m -and $m.shift) { [U32]::keybd_event(16, 0, 0, 0) }
                if ($m -and $m.alt)   { [U32]::keybd_event(18, 0, 0, 0) }
                if ($m -and $m.meta)  { [U32]::keybd_event(91, 0, 0, 0) }
                $vk = $VK[$e.key]
                if (-not $vk -and $e.key -and $e.key.Length -eq 1) {
                    $vk = [int][char]($e.key.ToUpper()[0])
                }
                if ($vk) { [U32]::keybd_event([byte]$vk, 0, 0, 0) }
            }
            'keyup' {
                $vk = $VK[$e.key]
                if (-not $vk -and $e.key -and $e.key.Length -eq 1) {
                    $vk = [int][char]($e.key.ToUpper()[0])
                }
                if ($vk) { [U32]::keybd_event([byte]$vk, 0, 2, 0) }
                if ($m -and $m.meta)  { [U32]::keybd_event(91, 0, 2, 0) }
                if ($m -and $m.alt)   { [U32]::keybd_event(18, 0, 2, 0) }
                if ($m -and $m.shift) { [U32]::keybd_event(16, 0, 2, 0) }
                if ($m -and $m.ctrl)  { [U32]::keybd_event(17, 0, 2, 0) }
            }
            'set_display_resolution' {
                $w = [int]$e.width; $h = [int]$e.height
                $dm = New-Object Disp+DEVMODE
                $dm.dmSize = [System.Runtime.InteropServices.Marshal]::SizeOf($dm)
                # Seed all fields from the current mode so only width/height change
                [Disp]::EnumDisplaySettings($null, -1, [ref]$dm) | Out-Null
                $dm.dmPelsWidth  = $w
                $dm.dmPelsHeight = $h
                $dm.dmFields = 0x00080000 -bor 0x00100000  # DM_PELSWIDTH | DM_PELSHEIGHT
                [Disp]::ChangeDisplaySettings([ref]$dm, 0) | Out-Null
            }
        }
    } catch {}
}
