import { spawn } from 'child_process'
import type { Rect, ScreenInfo } from './types.js'

export type { Rect, ScreenInfo }

/**
 * Maps layout app names (as used in layouts.ts) to Windows process/executable names.
 * Process name: used to find the running window via Get-Process.
 * Launch name:  used with Start-Process to open the app.
 */
const APP_MAP: Record<string, { process: string; launch: string }> = {
  'Google Chrome': { process: 'chrome', launch: 'chrome' },
  'Alacritty': { process: 'alacritty', launch: 'alacritty' },
  'Firefox': { process: 'firefox', launch: 'firefox' },
  'Mozilla Firefox': { process: 'firefox', launch: 'firefox' },
  'Visual Studio Code': { process: 'Code', launch: 'code' },
  'Code': { process: 'Code', launch: 'code' },
  'Windows Terminal': { process: 'WindowsTerminal', launch: 'wt' },
  'Notepad': { process: 'notepad', launch: 'notepad' },
  'Notepad++': { process: 'notepad++', launch: 'notepad++' },
}

function toProcessName(appName: string): string {
  return APP_MAP[appName]?.process ?? appName
}

function toLaunchName(appName: string): string {
  return APP_MAP[appName]?.launch ?? appName
}

/**
 * Run a PowerShell script encoded as Base64 UTF-16LE to avoid escaping issues.
 * Returns stdout as a trimmed string. Rejects on non-zero exit.
 */
function runPowerShell(script: string): Promise<string> {
  // Suppress progress bars — PowerShell emits CLIXML progress records to stderr
  // when its output streams are redirected, which produces noisy XML in error messages.
  const wrapped = `$ProgressPreference = 'SilentlyContinue'\n${script}`
  const encoded = Buffer.from(wrapped, 'utf16le').toString('base64')
  return new Promise((resolve, reject) => {
    const proc = spawn(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let stdout = ''
    let stderr = ''
    proc.stdout!.on('data', (d: Buffer) => (stdout += d.toString()))
    proc.stderr!.on('data', (d: Buffer) => (stderr += d.toString()))
    proc.on('close', (code) => {
      if (code !== 0) {
        // Strip CLIXML envelope (e.g. "#< CLIXML\n<Objs ...>") — extract plain text from <S> tags
        let msg = stderr.trim()
        if (msg.startsWith('#< CLIXML')) {
          const matches = [...msg.matchAll(/<S S="Error">([^<]*)<\/S>/g)]
          msg = matches
            .map((m) => m[1].replace(/_x000D__x000A_/g, '\n').replace(/_x[0-9A-F]{4}_/g, ''))
            .join('')
            .trim()
        }
        reject(new Error(msg || `PowerShell exited with code ${code}`))
      } else {
        resolve(stdout.trim())
      }
    })
  })
}

/**
 * Get all connected screens using System.Windows.Forms.Screen.
 * Primary monitor is always index 0. Coordinates use top-left origin (virtual desktop).
 */
export async function getScreens(): Promise<ScreenInfo[]> {
  const script = `
Add-Type -AssemblyName System.Windows.Forms
# Sort so primary screen is first (index 0), then others left-to-right
$sorted = [System.Windows.Forms.Screen]::AllScreens | Sort-Object { if ($_.Primary) { 0 } else { $_.Bounds.X } }
$result = @()
$i = 0
foreach ($s in $sorted) {
    $result += [PSCustomObject]@{
        index  = $i
        x      = $s.Bounds.X
        y      = $s.Bounds.Y
        w      = $s.Bounds.Width
        h      = $s.Bounds.Height
        isMain = [bool]$s.Primary
    }
    $i++
}
Write-Output (ConvertTo-Json -InputObject $result -Compress)
`
  const output = await runPowerShell(script)
  const parsed = JSON.parse(output)
  // JSON.parse returns an object (not array) when there's only one screen
  return Array.isArray(parsed) ? parsed : [parsed]
}

/**
 * Set a window's position and size via Win32 SetWindowPos.
 * Restores the window first if it is minimised or maximised.
 */
export async function setWindowFrame(appName: string, frame: Rect): Promise<void> {
  const processName = toProcessName(appName)
  const x = Math.round(frame.x)
  const y = Math.round(frame.y)
  const w = Math.round(frame.w)
  const h = Math.round(frame.h)

  const script = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WinHelper {
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmd);
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
}
"@ -ErrorAction SilentlyContinue

$proc = Get-Process -Name '${processName}' -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero } |
    Select-Object -First 1

if ($null -eq $proc) { Write-Error "Process '${processName}' not found"; exit 1 }

$hwnd = $proc.MainWindowHandle
[WinHelper]::ShowWindow($hwnd, 9) | Out-Null         # SW_RESTORE (un-minimise / un-maximise)
# SWP_NOZORDER (0x0004) | SWP_SHOWWINDOW (0x0040) = 0x0044
[WinHelper]::SetWindowPos($hwnd, [IntPtr]::Zero, ${x}, ${y}, ${w}, ${h}, 0x0044) | Out-Null
`
  await runPowerShell(script)
}

/**
 * Bring an application window to the foreground.
 */
export async function activateApp(appName: string): Promise<void> {
  const processName = toProcessName(appName)
  const script = `
Add-Type @"
using System.Runtime.InteropServices;
public class FgWin {
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(System.IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr hWnd, int nCmd);
}
"@ -ErrorAction SilentlyContinue

$proc = Get-Process -Name '${processName}' -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -ne [System.IntPtr]::Zero } |
    Select-Object -First 1

if ($proc) {
    [FgWin]::ShowWindow($proc.MainWindowHandle, 9) | Out-Null
    [FgWin]::SetForegroundWindow($proc.MainWindowHandle) | Out-Null
}
`
  await runPowerShell(script)
}

/**
 * Launch an application. If already running, activates it instead.
 */
export async function launchApp(appName: string): Promise<void> {
  const launchName = toLaunchName(appName)
  const script = `Start-Process '${launchName}'`
  await runPowerShell(script)
}

/**
 * Check if an application is currently running.
 */
export async function isAppRunning(appName: string): Promise<boolean> {
  const processName = toProcessName(appName)
  const script = `
$proc = Get-Process -Name '${processName}' -ErrorAction SilentlyContinue
if ($null -ne $proc) { Write-Output 'true' } else { Write-Output 'false' }
`
  const output = await runPowerShell(script)
  return output.trim() === 'true'
}

/**
 * Show a Windows toast/balloon notification.
 */
export async function showNotification(message: string): Promise<void> {
  // Use WinRT toast (Windows 10+). Falls back silently on failure.
  const safeMsg = message.replace(/'/g, "''")
  const script = `
try {
    [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
    $xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent(
        [Windows.UI.Notifications.ToastTemplateType]::ToastText01)
    $xml.GetElementsByTagName('text').Item(0).InnerText = 'quickscreen: ${safeMsg}'
    $toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
    [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('quickscreen').Show($toast)
} catch {}
`
  await runPowerShell(script).catch(() => {}) // non-critical
}
