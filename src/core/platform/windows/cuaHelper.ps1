# Backboard computer-use helper for Windows.
#
# A long-lived PowerShell host that reads one JSON request per line from stdin
# and writes one JSON response per line to stdout. Keeping the process alive
# avoids the ~0.5-1s PowerShell startup cost per action, and keeps the UI
# Automation COM objects and the compiled Win32 interop warm.
#
# Coordinate contract: points are physical pixels of the target display
# (the process is made per-monitor DPI aware), origin top-left of that display.

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::InputEncoding = [System.Text.Encoding]::UTF8

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

Add-Type -Namespace Backboard -Name Native -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
[DllImport("shcore.dll")] public static extern int SetProcessDpiAwareness(int value);
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr hwnd, uint flags);
[DllImport("user32.dll")] public static extern bool GetMonitorInfo(IntPtr hMonitor, ref MONITORINFO lpmi);
[DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
[DllImport("user32.dll")] public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
[DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
[StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
[StructLayout(LayoutKind.Sequential)] public struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; }
[StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr dwExtraInfo; }
[StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr dwExtraInfo; }
[StructLayout(LayoutKind.Explicit)] public struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
[StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public INPUTUNION u; }
public const uint INPUT_MOUSE = 0, INPUT_KEYBOARD = 1;
public const uint MOUSEEVENTF_MOVE = 0x0001, MOUSEEVENTF_LEFTDOWN = 0x0002, MOUSEEVENTF_LEFTUP = 0x0004, MOUSEEVENTF_RIGHTDOWN = 0x0008, MOUSEEVENTF_RIGHTUP = 0x0010, MOUSEEVENTF_MIDDLEDOWN = 0x0020, MOUSEEVENTF_MIDDLEUP = 0x0040, MOUSEEVENTF_WHEEL = 0x0800, MOUSEEVENTF_HWHEEL = 0x1000, MOUSEEVENTF_ABSOLUTE = 0x8000, MOUSEEVENTF_VIRTUALDESK = 0x4000;
public const uint KEYEVENTF_KEYUP = 0x0002, KEYEVENTF_UNICODE = 0x0004, KEYEVENTF_EXTENDEDKEY = 0x0001;
public static void Mouse(uint flags, int data) {
  INPUT[] inputs = new INPUT[1];
  inputs[0].type = INPUT_MOUSE;
  inputs[0].u.mi.dwFlags = flags;
  inputs[0].u.mi.mouseData = (uint)data;
  SendInput(1, inputs, Marshal.SizeOf(typeof(INPUT)));
}
public static void Key(ushort vk, bool up, bool extended) {
  INPUT[] inputs = new INPUT[1];
  inputs[0].type = INPUT_KEYBOARD;
  inputs[0].u.ki.wVk = vk;
  inputs[0].u.ki.dwFlags = (up ? KEYEVENTF_KEYUP : 0) | (extended ? KEYEVENTF_EXTENDEDKEY : 0);
  SendInput(1, inputs, Marshal.SizeOf(typeof(INPUT)));
}
public static void Unicode(char ch, bool up) {
  INPUT[] inputs = new INPUT[1];
  inputs[0].type = INPUT_KEYBOARD;
  inputs[0].u.ki.wScan = ch;
  inputs[0].u.ki.dwFlags = KEYEVENTF_UNICODE | (up ? KEYEVENTF_KEYUP : 0);
  SendInput(1, inputs, Marshal.SizeOf(typeof(INPUT)));
}
'@

try { [void][Backboard.Native]::SetProcessDpiAwareness(2) } catch { try { [void][Backboard.Native]::SetProcessDPIAware() } catch {} }

$script:VirtualKeys = @{
  'ENTER'=0x0D;'RETURN'=0x0D;'TAB'=0x09;'SPACE'=0x20;'BACKSPACE'=0x08;'DELETE'=0x2E;'FORWARDDELETE'=0x2E;'ESC'=0x1B;'ESCAPE'=0x1B
  'LEFT'=0x25;'UP'=0x26;'RIGHT'=0x27;'DOWN'=0x28;'HOME'=0x24;'END'=0x23;'PAGEUP'=0x21;'PAGEDOWN'=0x22;'INSERT'=0x2D;'CAPSLOCK'=0x14
  'META'=0x5B;'WIN'=0x5B;'CMD'=0x5B;'COMMAND'=0x5B;'SHIFT'=0x10;'CONTROL'=0x11;'CTRL'=0x11;'ALT'=0x12;'OPTION'=0x12;'PRINTSCREEN'=0x2C
  'F1'=0x70;'F2'=0x71;'F3'=0x72;'F4'=0x73;'F5'=0x74;'F6'=0x75;'F7'=0x76;'F8'=0x77;'F9'=0x78;'F10'=0x79;'F11'=0x7A;'F12'=0x7B
  '-'=0xBD;'='=0xBB;'['=0xDB;']'=0xDD;'\'=0xDC;';'=0xBA;"'"=0xDE;','=0xBC;'.'=0xBE;'/'=0xBF;'`'=0xC0
}
$script:ExtendedKeys = @(0x2E,0x25,0x26,0x27,0x28,0x24,0x23,0x21,0x22,0x2D,0x5B)
$script:ModifierKeys = @{ 'meta'=0x5B;'control'=0x11;'ctrl'=0x11;'alt'=0x12;'option'=0x12;'shift'=0x10 }

function Get-TargetDisplay {
  $hwnd = [Backboard.Native]::GetForegroundWindow()
  $monitor = [Backboard.Native]::MonitorFromWindow($hwnd, 2)
  $info = New-Object Backboard.Native+MONITORINFO
  $info.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf($info)
  if (-not [Backboard.Native]::GetMonitorInfo($monitor, [ref]$info)) {
    $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    return @{ x=$b.X; y=$b.Y; width=$b.Width; height=$b.Height; id=0 }
  }
  $r = $info.rcMonitor
  return @{ x=$r.Left; y=$r.Top; width=($r.Right-$r.Left); height=($r.Bottom-$r.Top); id=[int64]$monitor }
}

function Invoke-Capture($req) {
  $d = Get-TargetDisplay
  $bmp = New-Object System.Drawing.Bitmap $d.width, $d.height
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($d.x, $d.y, 0, 0, (New-Object System.Drawing.Size $d.width, $d.height))
  $g.Dispose()
  $source = $bmp
  $region = $null
  if ($req.region) {
    $rx=[int]$req.region.x; $ry=[int]$req.region.y; $rw=[int]$req.region.width; $rh=[int]$req.region.height
    $rect = New-Object System.Drawing.Rectangle $rx,$ry,$rw,$rh
    $rect.Intersect((New-Object System.Drawing.Rectangle 0,0,$d.width,$d.height))
    if ($rect.Width -lt 1 -or $rect.Height -lt 1) { throw 'zoom region is outside the screen' }
    $source = $bmp.Clone($rect, $bmp.PixelFormat)
    $bmp.Dispose()
    $region = @{ x=$rect.X; y=$rect.Y; width=$rect.Width; height=$rect.Height }
  }
  $maxWidth = if ($req.maxWidth) { [int]$req.maxWidth } else { 1280 }
  $out = $source
  if ($source.Width -gt $maxWidth) {
    $h = [int][math]::Round($source.Height * ($maxWidth / $source.Width))
    $out = New-Object System.Drawing.Bitmap $maxWidth, [math]::Max($h,1)
    $g2 = [System.Drawing.Graphics]::FromImage($out)
    $g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g2.DrawImage($source, 0, 0, $maxWidth, [math]::Max($h,1))
    $g2.Dispose()
    $source.Dispose()
  }
  $format = if ($req.format -eq 'jpeg') { 'jpeg' } else { 'png' }
  if ($format -eq 'jpeg') {
    $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
    $params = New-Object System.Drawing.Imaging.EncoderParameters 1
    $q = if ($req.quality) { [int64]([double]$req.quality * 100) } else { 85 }
    $params.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality), $q
    $out.Save([string]$req.path, $codec, $params)
  } else {
    $out.Save([string]$req.path, [System.Drawing.Imaging.ImageFormat]::Png)
  }
  $sourceWidth = if ($region) { $region.width } else { $d.width }
  $result = @{
    path=[string]$req.path; bytes=(Get-Item $req.path).Length; format=$format
    imageSize=@{ width=$out.Width; height=$out.Height }
    screenSize=@{ width=$d.width; height=$d.height }
    scale=($out.Width / $sourceWidth)
    display=@{ displayId=$d.id; origin=@{x=$d.x;y=$d.y}; points=@{width=$d.width;height=$d.height}; pixels=@{width=$d.width;height=$d.height}; scale=1 }
  }
  if ($region) { $result.region = $region }
  $out.Dispose()
  return $result
}

$script:InteractiveTypes = @('Button','CheckBox','ComboBox','Edit','Hyperlink','ListItem','MenuItem','RadioButton','TabItem','TreeItem','DataItem','Slider','Spinner','SplitButton','Text','Image','Document','Window','Pane','ScrollBar','Header','HeaderItem','Custom')

function Invoke-Accessibility($req) {
  $d = Get-TargetDisplay
  $max = if ($req.maxElements) { [int]$req.maxElements } else { 80 }
  $maxDepth = if ($req.maxDepth) { [int]$req.maxDepth } else { 12 }
  $items = New-Object System.Collections.Generic.List[object]
  $hwnd = [Backboard.Native]::GetForegroundWindow()
  $root = $null
  try { $root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd) } catch {}
  if ($null -eq $root) { return @{ elements=@(); trusted=$true } }
  $cache = New-Object System.Windows.Automation.CacheRequest
  $cache.Add([System.Windows.Automation.AutomationElement]::NameProperty)
  $cache.Add([System.Windows.Automation.AutomationElement]::ControlTypeProperty)
  $cache.Add([System.Windows.Automation.AutomationElement]::BoundingRectangleProperty)
  $cache.Add([System.Windows.Automation.AutomationElement]::IsEnabledProperty)
  $cache.Add([System.Windows.Automation.AutomationElement]::HasKeyboardFocusProperty)
  $cache.Add([System.Windows.Automation.AutomationElement]::IsOffscreenProperty)
  $cache.TreeScope = [System.Windows.Automation.TreeScope]::Element -bor [System.Windows.Automation.TreeScope]::Descendants
  $cache.TreeFilter = [System.Windows.Automation.Automation]::ControlViewCondition
  $cached = $root.GetUpdatedCache($cache)
  $pid = $root.Current.ProcessId
  $appName = $null
  try { $appName = (Get-Process -Id $pid).ProcessName } catch {}
  $focusedId = $null
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  $stack = New-Object System.Collections.Generic.Stack[object]
  $stack.Push(@($cached, 0))
  while ($stack.Count -gt 0 -and $items.Count -lt $max) {
    $entry = $stack.Pop(); $node = $entry[0]; $depth = [int]$entry[1]
    if ($null -eq $node -or $depth -gt $maxDepth) { continue }
    $rect = $node.Cached.BoundingRectangle
    $type = $node.Cached.ControlType.ProgrammaticName.Replace('ControlType.', '')
    if (-not $node.Cached.IsOffscreen -and -not $rect.IsEmpty -and $rect.Width -gt 0 -and $rect.Height -gt 0 -and $script:InteractiveTypes -contains $type) {
      $name = $node.Cached.Name
      if (-not ($type -eq 'Text' -and [string]::IsNullOrWhiteSpace($name))) {
        $item = @{ id=('el_' + ($items.Count + 1)); role=$type; bounds=@{ x=[double]($rect.X - $d.x); y=[double]($rect.Y - $d.y); width=[double]$rect.Width; height=[double]$rect.Height } }
        if (-not [string]::IsNullOrWhiteSpace($name)) { $item.name = if ($name.Length -gt 120) { $name.Substring(0,120) + '…' } else { $name } }
        if (-not $node.Cached.IsEnabled) { $item.enabled = $false }
        if ($node.Cached.HasKeyboardFocus) { $item.focused = $true; $focusedId = $item.id }
        $items.Add($item)
      }
    }
    $children = @()
    try { $children = $node.CachedChildren } catch {}
    for ($i = $children.Count - 1; $i -ge 0; $i--) { $stack.Push(@($children.Item($i), $depth + 1)) }
  }
  $result = @{ appName=$appName; processId=$pid; windowTitle=$cached.Cached.Name; elements=$items.ToArray(); trusted=$true }
  $wr = $cached.Cached.BoundingRectangle
  if (-not $wr.IsEmpty) { $result.windowBounds = @{ x=[double]($wr.X - $d.x); y=[double]($wr.Y - $d.y); width=[double]$wr.Width; height=[double]$wr.Height } }
  if ($focusedId) { $result.focusedElementId = $focusedId }
  return $result
}

function Get-Thumbnail($d) {
  $bmp = New-Object System.Drawing.Bitmap $d.width, $d.height
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($d.x, $d.y, 0, 0, (New-Object System.Drawing.Size $d.width, $d.height))
  $g.Dispose()
  $small = New-Object System.Drawing.Bitmap 96, 54
  $g2 = [System.Drawing.Graphics]::FromImage($small)
  $g2.DrawImage($bmp, 0, 0, 96, 54)
  $g2.Dispose(); $bmp.Dispose()
  $bytes = New-Object byte[] (96*54*3)
  $n = 0
  for ($y = 0; $y -lt 54; $y++) { for ($x = 0; $x -lt 96; $x++) { $c = $small.GetPixel($x,$y); $bytes[$n++]=$c.R; $bytes[$n++]=$c.G; $bytes[$n++]=$c.B } }
  $small.Dispose()
  return $bytes
}

function Invoke-Settle($req) {
  $d = Get-TargetDisplay
  $timeout = if ($req.timeoutMs) { [double]$req.timeoutMs } else { 1500 }
  $interval = if ($req.intervalMs) { [double]$req.intervalMs } else { 100 }
  $initial = if ($req.initialDelayMs) { [double]$req.initialDelayMs } else { 50 }
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  Start-Sleep -Milliseconds $initial
  $prev = Get-Thumbnail $d
  $frames = 1
  while ($sw.ElapsedMilliseconds -lt $timeout) {
    Start-Sleep -Milliseconds $interval
    $cur = Get-Thumbnail $d
    $frames++
    $changed = 0
    for ($i = 0; $i -lt $cur.Length; $i++) { if ([math]::Abs([int]$cur[$i] - [int]$prev[$i]) -gt 24) { $changed++ } }
    if (($changed / $cur.Length) -le 0.004) { return @{ settled=$true; elapsedMs=[int]$sw.ElapsedMilliseconds; frames=$frames } }
    $prev = $cur
  }
  return @{ settled=$false; elapsedMs=[int]$sw.ElapsedMilliseconds; frames=$frames }
}

function Move-Cursor($d, $x, $y) {
  [void][Backboard.Native]::SetCursorPos([int]($d.x + $x), [int]($d.y + $y))
}

function Get-ButtonFlags($button) {
  switch ($button) {
    'right' { return @([Backboard.Native]::MOUSEEVENTF_RIGHTDOWN, [Backboard.Native]::MOUSEEVENTF_RIGHTUP) }
    'middle' { return @([Backboard.Native]::MOUSEEVENTF_MIDDLEDOWN, [Backboard.Native]::MOUSEEVENTF_MIDDLEUP) }
    default { return @([Backboard.Native]::MOUSEEVENTF_LEFTDOWN, [Backboard.Native]::MOUSEEVENTF_LEFTUP) }
  }
}

function Press-Modifiers($mods, $up) {
  foreach ($m in $mods) {
    $vk = $script:ModifierKeys[[string]$m.ToLower()]
    if ($vk) { [Backboard.Native]::Key([uint16]$vk, $up, ($script:ExtendedKeys -contains $vk)) }
  }
}

function Invoke-Click($req) {
  $d = Get-TargetDisplay
  Move-Cursor $d ([double]$req.x) ([double]$req.y)
  Start-Sleep -Milliseconds 30
  $flags = Get-ButtonFlags ([string]$req.button)
  $count = if ($req.count) { [int]$req.count } else { 1 }
  $mods = @(); if ($req.modifiers) { $mods = @($req.modifiers) }
  Press-Modifiers $mods $false
  for ($i = 0; $i -lt $count; $i++) {
    [Backboard.Native]::Mouse($flags[0], 0); Start-Sleep -Milliseconds 15
    [Backboard.Native]::Mouse($flags[1], 0)
    if ($i -lt $count - 1) { Start-Sleep -Milliseconds 60 }
  }
  Press-Modifiers $mods $true
}

function Invoke-Drag($req) {
  $d = Get-TargetDisplay
  $flags = Get-ButtonFlags ([string]$req.button)
  Move-Cursor $d ([double]$req.fromX) ([double]$req.fromY)
  Start-Sleep -Milliseconds 40
  [Backboard.Native]::Mouse($flags[0], 0)
  Start-Sleep -Milliseconds 60
  for ($s = 1; $s -le 12; $s++) {
    $t = $s / 12.0
    Move-Cursor $d ([double]$req.fromX + ([double]$req.toX - [double]$req.fromX) * $t) ([double]$req.fromY + ([double]$req.toY - [double]$req.fromY) * $t)
    Start-Sleep -Milliseconds 16
  }
  Start-Sleep -Milliseconds 60
  [Backboard.Native]::Mouse($flags[1], 0)
}

function Invoke-Scroll($req) {
  $d = Get-TargetDisplay
  if ($null -ne $req.x -and $null -ne $req.y) { Move-Cursor $d ([double]$req.x) ([double]$req.y); Start-Sleep -Milliseconds 30 }
  $dy = if ($req.dy) { [int]$req.dy } else { 0 }
  $dx = if ($req.dx) { [int]$req.dx } else { 0 }
  if ($dy -ne 0) { [Backboard.Native]::Mouse([Backboard.Native]::MOUSEEVENTF_WHEEL, (-$dy * 120)) }
  if ($dx -ne 0) { [Backboard.Native]::Mouse([Backboard.Native]::MOUSEEVENTF_HWHEEL, ($dx * 120)) }
}

function Invoke-Type($req) {
  foreach ($ch in ([string]$req.text).ToCharArray()) {
    [Backboard.Native]::Unicode($ch, $false)
    [Backboard.Native]::Unicode($ch, $true)
    Start-Sleep -Milliseconds 4
  }
}

function Resolve-Key($raw) {
  $key = ([string]$raw).ToUpper()
  if ($script:VirtualKeys.ContainsKey($key)) { return @{ vk=$script:VirtualKeys[$key]; shift=$false } }
  if ($key.Length -eq 1) {
    $scan = [System.Windows.Forms.Keys]$null
    $vk = [Backboard.Native]::GetSystemMetrics(0) # no-op to keep type loaded
    $code = [int][char]$key
    if (($code -ge 65 -and $code -le 90) -or ($code -ge 48 -and $code -le 57)) { return @{ vk=$code; shift=$false } }
    $shifted = @{ '!'='1';'@'='2';'#'='3';'$'='4';'%'='5';'^'='6';'&'='7';'*'='8';'('='9';')'='0';'_'='-';'+'='=';'{'='[';'}'=']';'|'='\';':'=';';'"'="'";'<'=',';'>'='.';'?'='/';'~'='`' }
    if ($shifted.ContainsKey([string]$raw)) { return @{ vk=$script:VirtualKeys[$shifted[[string]$raw]]; shift=$true } }
  }
  throw "Unsupported key: $raw"
}

function Invoke-Key($req) {
  $resolved = Resolve-Key $req.key
  $mods = @(); if ($req.modifiers) { $mods = @($req.modifiers) }
  if ($resolved.shift) { $mods += 'shift' }
  $repeat = if ($req.repeat) { [math]::Max(1, [math]::Min(100, [int]$req.repeat)) } else { 1 }
  $hold = if ($req.holdMs) { [int]$req.holdMs } else { 12 }
  $ext = $script:ExtendedKeys -contains $resolved.vk
  Press-Modifiers $mods $false
  for ($i = 0; $i -lt $repeat; $i++) {
    [Backboard.Native]::Key([uint16]$resolved.vk, $false, $ext)
    Start-Sleep -Milliseconds $hold
    [Backboard.Native]::Key([uint16]$resolved.vk, $true, $ext)
    if ($i -lt $repeat - 1) { Start-Sleep -Milliseconds 30 }
  }
  Press-Modifiers $mods $true
}

function Write-Response($obj) {
  [Console]::Out.WriteLine(($obj | ConvertTo-Json -Depth 8 -Compress))
  [Console]::Out.Flush()
}

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ([string]::IsNullOrWhiteSpace($line)) { continue }
  $req = $null
  try { $req = $line | ConvertFrom-Json } catch { continue }
  $id = $req.id
  try {
    $body = $null
    switch ([string]$req.op) {
      'ping' { $body = @{ pong=$true; trusted=$true; pid=$PID } }
      'display' { $d = Get-TargetDisplay; $body = @{ display=@{ displayId=$d.id; origin=@{x=$d.x;y=$d.y}; points=@{width=$d.width;height=$d.height}; pixels=@{width=$d.width;height=$d.height}; scale=1 }; trusted=$true } }
      'capture' { $body = Invoke-Capture $req }
      'ax' { $body = Invoke-Accessibility $req }
      'observe' { $body = Invoke-Capture $req; $body.accessibility = Invoke-Accessibility $req }
      'settle' { $body = Invoke-Settle $req }
      'click' { Invoke-Click $req; $body = @{} }
      'move' { $d = Get-TargetDisplay; Move-Cursor $d ([double]$req.x) ([double]$req.y); $body = @{} }
      'drag' { Invoke-Drag $req; $body = @{} }
      'scroll' { Invoke-Scroll $req; $body = @{} }
      'type' { Invoke-Type $req; $body = @{} }
      'key' { Invoke-Key $req; $body = @{} }
      'openApp' { Start-Process ([string]$req.appName); $body = @{} }
      default { throw "Unknown op: $($req.op)" }
    }
    $body.id = $id; $body.ok = $true
    Write-Response $body
  } catch {
    Write-Response @{ id=$id; ok=$false; error=[string]$_.Exception.Message }
  }
}
