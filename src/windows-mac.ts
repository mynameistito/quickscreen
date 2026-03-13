import { spawn } from 'child_process'
import type { Rect, ScreenInfo } from './types.js'

export type { Rect, ScreenInfo }

/**
 * Run an osascript command (AppleScript or JXA) and return stdout.
 * Rejects on non-zero exit or stderr.
 */
function osascript(script: string, lang: 'AppleScript' | 'JavaScript' = 'AppleScript'): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = lang === 'JavaScript' ? ['-l', 'JavaScript', '-e', script] : ['-e', script]
    const proc = spawn('osascript', args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', (d) => (stdout += d))
    proc.stderr.on('data', (d) => (stderr += d))
    proc.on('close', (code) => {
      if (code !== 0) reject(new Error(`osascript exited ${code}: ${stderr.trim()}`))
      else resolve(stdout.trim())
    })
  })
}

/**
 * Get all connected screens with their geometry using JXA + NSScreen.
 * Returns an array sorted by screen index, with coordinates matching
 * what AVFoundation and ffmpeg expect.
 */
export async function getScreens(): Promise<ScreenInfo[]> {
  // JXA script that reads NSScreen frames
  // NSScreen coordinate system has origin at bottom-left, but we need top-left origin
  // for ffmpeg crop coordinates. The main screen's origin is always (0,0) in both systems
  // but y-axis is flipped. We convert here.
  const jxa = `
    ObjC.import('AppKit');
    const screens = $.NSScreen.screens;
    const mainFrame = screens.objectAtIndex(0).frame;
    const mainH = mainFrame.size.height;
    const result = [];
    for (let i = 0; i < screens.count; i++) {
      const s = screens.objectAtIndex(i);
      const f = s.frame;
      const vf = s.visibleFrame;
      // Convert from bottom-left origin to top-left origin
      const y = mainH - f.origin.y - f.size.height;
      result.push({
        index: i,
        x: f.origin.x,
        y: y,
        w: f.size.width,
        h: f.size.height,
        isMain: i === 0,
      });
    }
    JSON.stringify(result);
  `
  const out = await osascript(jxa, 'JavaScript')
  return JSON.parse(out) as ScreenInfo[]
}

/**
 * Set a window's position and size using AppleScript.
 * Handles the AXEnhancedUserInterface workaround for apps like Alacritty
 * that resist frame changes.
 */
export async function setWindowFrame(appName: string, frame: Rect): Promise<void> {
  // First try the JXA approach with AXEnhancedUserInterface workaround
  // This is needed for Alacritty and similar apps
  const jxa = `
    ObjC.import('AppKit');
    ObjC.import('ApplicationServices');

    const app = Application("${appName}");
    app.includeStandardAdditions = true;

    // Get the process
    const sysEvents = Application("System Events");
    const proc = sysEvents.processes.whose({name: {_contains: "${appName}"}})[0];

    if (proc) {
      try {
        // Try to get and toggle AXEnhancedUserInterface
        const axApp = proc.attributes.byName("AXEnhancedUserInterface");
        const wasEnhanced = axApp.value();
        if (wasEnhanced) {
          axApp.value = false;
        }

        // Set position and size
        const win = proc.windows[0];
        win.position = [${Math.round(frame.x)}, ${Math.round(frame.y)}];
        win.size = [${Math.round(frame.w)}, ${Math.round(frame.h)}];

        // Restore AXEnhancedUserInterface
        if (wasEnhanced) {
          delay(0.1);
          axApp.value = true;
        }
      } catch(e) {
        // Fallback: set without AX workaround
        const win = proc.windows[0];
        win.position = [${Math.round(frame.x)}, ${Math.round(frame.y)}];
        win.size = [${Math.round(frame.w)}, ${Math.round(frame.h)}];
      }
    }
  `
  await osascript(jxa, 'JavaScript')
}

/**
 * Activate (bring to front) an application.
 */
export async function activateApp(appName: string): Promise<void> {
  await osascript(`tell application "${appName}" to activate`)
}

/**
 * Launch an application if not running, or activate it if already running.
 */
export async function launchApp(appName: string): Promise<void> {
  await osascript(`
    tell application "${appName}"
      activate
    end tell
  `)
}

/**
 * Check if an application is currently running.
 */
export async function isAppRunning(appName: string): Promise<boolean> {
  const result = await osascript(`
    tell application "System Events"
      set appRunning to (name of every process) contains "${appName}"
    end tell
    return appRunning
  `)
  return result === 'true'
}

/**
 * Show a macOS notification.
 */
export async function showNotification(message: string): Promise<void> {
  await osascript(`display notification "${message}" with title "quickscreen"`)
}
