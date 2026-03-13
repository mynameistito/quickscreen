import { spawn, execSync, type ChildProcess } from 'child_process'
import { homedir } from 'os'
import { join } from 'path'
import type { ScreenInfo, Rect } from './windows.js'

export interface RecordingOptions {
  /** Screen index (used on macOS for AVFoundation device selection) */
  screenIndex: number
  /** Screen geometry for calculating capture region */
  screenFrame: Rect
  /** Optional crop region (absolute virtual-desktop coordinates). If omitted, records full screen. */
  crop?: Rect
  /** Record audio from default system input device */
  audio: boolean
  /** Output file path */
  outputPath: string
  /** Video quality: lower = better (default: 18) */
  crf?: number
  /** Frame rate (default: 30) */
  framerate?: number
}

/**
 * Get the AVFoundation screen device name for a given screen index (macOS only).
 * AVFoundation lists capture screens as "Capture screen 0", "Capture screen 1", etc.
 */
export function getScreenName(screenIndex: number): string {
  return `Capture screen ${screenIndex}`
}

/**
 * Generate a timestamped output file path.
 * Uses .mp4 on Windows, .mov on macOS (both use H.264/AAC internally).
 */
export function generateOutputPath(outputDir?: string): string {
  const dir = outputDir || join(homedir(), 'Desktop')
  const timestamp = new Date()
    .toISOString()
    .replace(/T/, '-')
    .replace(/:/g, '')
    .replace(/\..+/, '')
  const ext = process.platform === 'win32' ? 'mp4' : 'mov'
  return join(dir, `recording-${timestamp}.${ext}`)
}

/**
 * Ensure dimensions are even (required by H.264 encoder).
 */
function ensureEven(n: number): number {
  const rounded = Math.floor(n)
  return rounded % 2 === 0 ? rounded : rounded - 1
}

/**
 * Build ffmpeg arguments for macOS (AVFoundation).
 */
function buildMacArgs(opts: RecordingOptions, crf: number, framerate: number): string[] {
  const screenName = getScreenName(opts.screenIndex)
  const audioDevice = opts.audio ? 'default' : 'none'

  const args: string[] = [
    '-f', 'avfoundation',
    '-framerate', String(framerate),
    '-i', `${screenName}:${audioDevice}`,
  ]

  if (opts.crop) {
    const cropX = Math.floor(opts.crop.x - opts.screenFrame.x)
    const cropY = Math.floor(opts.crop.y - opts.screenFrame.y)
    const cropW = ensureEven(opts.crop.w)
    const cropH = ensureEven(opts.crop.h)
    args.push('-vf', `crop=${cropW}:${cropH}:${cropX}:${cropY}`)
  }

  args.push(
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-crf', String(crf),
    '-pix_fmt', 'yuv420p',
  )

  if (opts.audio) {
    // Force 44100 Hz to avoid crackling from sample-rate mismatch
    args.push('-c:a', 'aac', '-b:a', '128k', '-ar', '44100')
  }

  args.push('-movflags', '+faststart', opts.outputPath)
  return args
}

/**
 * Get the Windows default audio input (recording) device name using Core Audio API.
 * Returns the friendly name or null if unable to determine.
 */
function getWindowsDefaultAudioInputDevice(): string | null {
  try {
    const ps = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;

[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
internal class MMDeviceEnumerator { }

[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IMMDeviceEnumerator {
int EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr devices);
int GetDefaultAudioEndpoint(int dataFlow, int role, out IntPtr device);
int RegisterEndpointNotificationCallback(IntPtr client);
int UnregisterEndpointNotificationCallback(IntPtr client);
}

[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IMMDevice {
int Activate(ref Guid iid, int dwClsCtx, IntPtr activationParams, out IntPtr interfacePtr);
int OpenPropertyStore(int stgmAccess, out IntPtr properties);
int GetId(out string id);
int GetState(out int state);
}

[Guid("71977F22-3D83-4618-BC85-CB2B9FCD572B"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IPropertyStore {
int GetCount(out int count);
int GetAt(int index, out PROPERTYKEY key);
int GetValue(ref PROPERTYKEY key, out PROPVARIANT value);
int SetValue(ref PROPERTYKEY key, ref PROPVARIANT value);
int Commit();
}

[StructLayout(LayoutKind.Sequential)]
public struct PROPERTYKEY {
public Guid fmtid;
public int pid;
}

[StructLayout(LayoutKind.Explicit)]
public struct PROPVARIANT {
[FieldOffset(0)] public int vt;
[FieldOffset(8)] public IntPtr pwszVal;
}
'@

$enumerator = [MMDeviceEnumerator]::new()
$enum = [IMMDeviceEnumerator]$enumerator
$device = [IntPtr]::Zero
$enum.GetDefaultAudioEndpoint(1, 0, [ref]$device) | Out-Null
$mmDevice = [IMMDevice]::new($device)
$name = [string]::Empty
$mmDevice.GetId([ref]$name) | Out-Null

$store = [IntPtr]::Zero
$mmDevice.OpenPropertyStore(0, [ref]$store) | Out-Null
$props = [IPropertyStore]::new($store)
$count = 0
$props.GetCount([ref]$count) | Out-Null

$friendlyNameKey = [PROPERTYKEY]::new()
$friendlyNameKey.fmtid = [Guid]"a45c254e-df1c-4efd-8020-67d146a850e0"
$friendlyNameKey.pid = 14

$value = [PROPVARIANT]::new()
$props.GetValue([ref]$friendlyNameKey, [ref]$value) | Out-Null
[System.Runtime.InteropServices.Marshal]::PtrToStringUni($value.pwszVal)
`
    const result = execSync(`powershell -NoProfile -NonInteractive -Command "${ps.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, {
      encoding: 'utf8',
      timeout: 5000,
    })
    const name = result.trim()
    return name.length > 0 ? name : null
  } catch {
    return null
  }
}

/**
 * Parse DirectShow device list from ffmpeg stderr output.
 * Returns an array of audio device names.
 */
function parseDshowAudioDevices(stderr: string): string[] {
  const devices: string[] = []
  let inAudioSection = false
  for (const line of stderr.split('\n')) {
    if (line.includes('DirectShow audio devices')) {
      inAudioSection = true
      continue
    }
    if (line.includes('DirectShow video devices')) {
      break
    }
    if (inAudioSection) {
      if (line.includes('Alternative name')) continue
      const match = line.match(/"([^"]+)"/)
      if (match) {
        devices.push(match[1])
      }
    }
  }
  return devices
}

/**
 * Find the best matching DirectShow audio device for a given friendly name.
 * DirectShow device names may include suffixes like " (Realtek Audio)" that aren't
 * in the Core Audio friendly name, so we do prefix matching.
 */
function findBestMatch(targetName: string, devices: string[]): string | null {
  const targetLower = targetName.toLowerCase()
  
  // Try exact match first
  const exactMatch = devices.find(d => d.toLowerCase() === targetLower)
  if (exactMatch) return exactMatch

  // Try finding device that starts with the target name (handles suffixes)
  const prefixMatch = devices.find(d => d.toLowerCase().startsWith(targetLower))
  if (prefixMatch) return prefixMatch

  // Try finding if target name appears anywhere in device name
  const containsMatch = devices.find(d => d.toLowerCase().includes(targetLower))
  if (containsMatch) return containsMatch

  return null
}

/**
 * Detect the default DirectShow audio capture device on Windows.
 * Prefers the Windows default input device if determinable, falls back to first available.
 * Returns the friendly name (e.g. "Microphone (Realtek Audio)") or null if none found.
 */
function getWindowsDshowAudioDevice(): Promise<string | null> {
  return new Promise((resolve) => {
    const proc = spawn('ffmpeg', ['-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'], {
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    proc.stderr!.on('data', (d: Buffer) => (stderr += d.toString()))
    proc.on('close', () => {
      const devices = parseDshowAudioDevices(stderr)
      if (devices.length === 0) {
        resolve(null)
        return
      }

      // Try to get Windows default audio input device
      const defaultDevice = getWindowsDefaultAudioInputDevice()
      if (defaultDevice) {
        const match = findBestMatch(defaultDevice, devices)
        if (match) {
          resolve(match)
          return
        }
      }

      // Fall back to first available device
      resolve(devices[0])
    })
  })
}

/**
 * Build ffmpeg arguments for Windows (gdigrab video + dshow audio).
 *
 * gdigrab captures in virtual-desktop coordinates (top-left origin, primary at 0,0).
 * We capture only the needed region directly via -offset_x/-offset_y/-video_size
 * to avoid capturing the entire virtual desktop.
 */
async function buildWindowsArgs(opts: RecordingOptions, crf: number, framerate: number): Promise<string[]> {
  const region = opts.crop ?? opts.screenFrame
  const captureX = Math.floor(region.x)
  const captureY = Math.floor(region.y)
  const captureW = ensureEven(region.w)
  const captureH = ensureEven(region.h)

  const args: string[] = [
    '-f', 'gdigrab',
    '-framerate', String(framerate),
    '-offset_x', String(captureX),
    '-offset_y', String(captureY),
    '-video_size', `${captureW}x${captureH}`,
    '-i', 'desktop',
  ]

  if (opts.audio) {
    const device = await getWindowsDshowAudioDevice()
    if (device) {
      args.push('-f', 'dshow', '-i', `audio=${device}`)
    } else {
      console.warn('No audio input device found — recording without audio')
    }
  }

  args.push(
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-crf', String(crf),
    '-pix_fmt', 'yuv420p',
  )

  if (opts.audio) {
    args.push('-c:a', 'aac', '-b:a', '128k', '-ar', '44100')
  }

  args.push('-movflags', '+faststart', opts.outputPath)
  return args
}

/**
 * Start an ffmpeg recording as a child process.
 * Returns the process handle — send 'q' to its stdin to stop gracefully.
 */
export async function startRecording(opts: RecordingOptions): Promise<ChildProcess> {
  const crf = opts.crf ?? 18
  const framerate = opts.framerate ?? 30

  const args =
    process.platform === 'win32'
      ? await buildWindowsArgs(opts, crf, framerate)
      : buildMacArgs(opts, crf, framerate)

  const proc = spawn('ffmpeg', args, {
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  return proc
}

/**
 * Stop a recording gracefully by sending 'q' to ffmpeg's stdin.
 * Waits for the process to exit, then returns.
 */
export function stopRecording(proc: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    if (proc.exitCode !== null) {
      resolve()
      return
    }

    proc.on('close', () => resolve())
    proc.on('error', reject)

    // Send 'q' to stdin — ffmpeg's graceful shutdown signal
    proc.stdin?.write('q')
  })
}

/**
 * Reveal a recorded file in the system file manager.
 * Uses Finder on macOS, Explorer on Windows.
 */
export function revealInFinder(filePath: string): void {
  if (process.platform === 'win32') {
    // explorer /select,"path" highlights the file in Explorer
    spawn('explorer', [`/select,${filePath}`], { stdio: 'ignore', detached: true }).unref()
  } else {
    spawn('open', ['-R', filePath], { stdio: 'ignore', detached: true }).unref()
  }
}

/**
 * Calculate the recording crop rect and window frames for a layout.
 */
export function calculateLayoutGeometry(
  screen: ScreenInfo,
  padding: { edge: number; gap: number; top: number; bottom: number },
  windowCount: number,
  recording: { area: 'fullscreen' | 'windows'; aspectRatio?: number },
): {
  windowFrames: Rect[]
  recordingRect: Rect | undefined
} {
  const { w: screenW, h: screenH, x: screenX, y: screenY } = screen

  // Apply aspect ratio constraint if specified
  let totalW = screenW
  let totalH = screenH
  if (recording.aspectRatio) {
    totalH = screenH
    totalW = totalH * recording.aspectRatio
    if (totalW > screenW) {
      totalW = screenW
      totalH = totalW / recording.aspectRatio
    }
  }

  // Calculate padding in pixels
  const edgePx = totalW * padding.edge
  const gapPx = totalW * padding.gap
  const topPx = totalH * padding.top
  const bottomPx = totalH * padding.bottom

  const usableW = totalW - 2 * edgePx
  const usableH = totalH - topPx - bottomPx

  // Centre the constrained area on the screen
  const offsetX = screenX + (screenW - totalW) / 2
  const offsetY = screenY + (screenH - totalH) / 2

  const windowFrames: Rect[] = []

  if (windowCount === 1) {
    // Centre: single window with padding
    windowFrames.push({
      x: offsetX + edgePx,
      y: offsetY + topPx,
      w: usableW,
      h: usableH,
    })
  } else if (windowCount === 2) {
    // Split: two windows side by side
    const availableW = usableW - gapPx
    const windowW = availableW / 2
    const leftX = offsetX + edgePx
    const rightX = leftX + windowW + gapPx
    const y = offsetY + topPx

    windowFrames.push(
      { x: leftX, y, w: windowW, h: usableH },
      { x: rightX, y, w: windowW, h: usableH },
    )
  }

  // Calculate recording rect
  let recordingRect: Rect | undefined
  if (recording.area === 'fullscreen') {
    recordingRect = undefined // No crop — record entire screen
  } else {
    // Record the window area plus padding
    const leftmost = Math.min(...windowFrames.map((f) => f.x))
    const rightmost = Math.max(...windowFrames.map((f) => f.x + f.w))
    const layoutW = rightmost - leftmost
    const layoutCenterX = leftmost + layoutW / 2
    const recW = ensureEven(layoutW + 2 * edgePx)
    const recX = layoutCenterX - recW / 2

    recordingRect = {
      x: recX,
      y: screenY,
      w: recW,
      h: ensureEven(screenH),
    }
  }

  return { windowFrames, recordingRect }
}
