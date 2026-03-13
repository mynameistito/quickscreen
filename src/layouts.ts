export interface WindowSlot {
  /** Application name as it appears on the host OS (e.g. "Google Chrome", "Alacritty", "Windows Terminal") */
  app: string
  /** Where to place the window on screen */
  position: 'left' | 'right' | 'center'
}

export interface Layout {
  /** Layout name used as the CLI argument */
  name: string
  /** Display index: 0 = main/primary, 1 = secondary, etc. */
  screen: number
  /** Whether to record microphone audio (uses system default input device) */
  audio: boolean
  /** Windows to arrange */
  windows: WindowSlot[]
  /** Padding as percentages of screen dimensions */
  padding: {
    /** Left/right edge padding as fraction of screen width (e.g. 0.05 = 5%) */
    edge: number
    /** Gap between windows as fraction of screen width */
    gap: number
    /** Top padding as fraction of screen height */
    top: number
    /** Bottom padding as fraction of screen height */
    bottom: number
  }
  /** What area to record */
  recording: {
    /** 'fullscreen' records the entire display, 'windows' crops to the arranged window area */
    area: 'fullscreen' | 'windows'
    /** Constrain the layout to an aspect ratio before placing windows (e.g. 16/9) */
    aspectRatio?: number
  }
}

/**
 * Built-in layouts.
 * These match the original Hammerspoon layouts:
 * - "split": Chrome on left + terminal on right, 16:9 aspect ratio on main display
 * - "center": Terminal centered on secondary display, fullscreen recording
 */
export const defaultLayouts: Layout[] = [
  {
    name: 'split',
    screen: 0,
    audio: true,
    windows: [
      { app: 'Google Chrome', position: 'left' },
      { app: process.platform === 'win32' ? 'Windows Terminal' : 'Alacritty', position: 'right' },
    ],
    padding: { edge: 0.035, gap: 0.023, top: 0.083, bottom: 0.083 },
    recording: { area: 'windows', aspectRatio: 16 / 9 },
  },
  {
    name: 'center',
    screen: 1,
    audio: true,
    windows: [{ app: process.platform === 'win32' ? 'Windows Terminal' : 'Alacritty', position: 'center' }],
    padding: { edge: 0.10, gap: 0, top: 0.10, bottom: 0.10 },
    recording: { area: 'fullscreen' },
  },
]
