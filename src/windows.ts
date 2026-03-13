/**
 * Platform dispatcher — re-exports the correct window-management implementation
 * based on the current operating system.
 *
 * Supported platforms:
 *   darwin  → macOS  (osascript / JXA / NSScreen)
 *   win32   → Windows (PowerShell / Win32 API)
 */

export type { Rect, ScreenInfo } from './types.js'

const { platform } = process

if (platform !== 'darwin' && platform !== 'win32') {
  throw new Error(`quickscreen does not support platform: ${platform}`)
}

const impl =
  platform === 'win32'
    ? await import('./windows-win.js')
    : await import('./windows-mac.js')

export const getScreens = impl.getScreens
export const setWindowFrame = impl.setWindowFrame
export const activateApp = impl.activateApp
export const launchApp = impl.launchApp
export const isAppRunning = impl.isAppRunning
export const showNotification = impl.showNotification
