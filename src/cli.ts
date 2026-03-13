#!/usr/bin/env node
import { goke } from 'goke'
import { z } from 'zod'
import { defaultLayouts } from './layouts.js'
import {
  generateOutputPath,
  startRecording,
  stopRecording,
  revealInFinder,
  calculateLayoutGeometry,
} from './recorder.js'
import {
  getScreens,
  setWindowFrame,
  launchApp,
  activateApp,
  isAppRunning,
} from './windows.js'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)
const pkg = require('../package.json') as { version: string }

const cli = goke('quickscreen')

cli
  .command('[layout]', `Start a layout, arrange windows, and record the screen. Press Ctrl+C to stop and save.

Available built-in layouts: ${defaultLayouts.map((l) => l.name).join(', ')}

If no layout is specified, lists available layouts.`)
  .option('--output [dir]', z.string().describe('Output directory for recordings (default: ~/Desktop)'))
  .option('--no-audio', 'Disable microphone recording')
  .option('--crf [crf]', z.number().default(18).describe('Video quality, lower is better'))
  .option('--list', 'List available layouts and exit')
  .example('# Record with the split layout (Chrome left, Alacritty right)')
  .example('quickscreen split')
  .example('# Record centered terminal on secondary display')
  .example('quickscreen center')
  .example('# Record without audio')
  .example('quickscreen split --no-audio')
  .example('# List available layouts')
  .example('quickscreen --list')
  .action(async (layoutName, options) => {
    // List layouts
    if (options.list || !layoutName) {
      console.log('Available layouts:\n')
      for (const layout of defaultLayouts) {
        const windows = layout.windows.map((w) => `${w.app} (${w.position})`).join(', ')
        console.log(`  ${layout.name}`)
        console.log(`    screen: ${layout.screen}, audio: ${layout.audio}`)
        console.log(`    windows: ${windows}`)
        console.log(`    recording: ${layout.recording.area}${layout.recording.aspectRatio ? ` (${layout.recording.aspectRatio}:1)` : ''}`)
        console.log()
      }
      return
    }

    // Find layout
    const layout = defaultLayouts.find((l) => l.name === layoutName)
    if (!layout) {
      console.error(`Unknown layout: "${layoutName}". Available: ${defaultLayouts.map((l) => l.name).join(', ')}`)
      process.exit(1)
    }

    // Override audio from flag
    const audio = options.audio !== false ? layout.audio : false

    // Get screen info
    console.log('Detecting screens...')
    const screens = await getScreens()
    if (layout.screen >= screens.length) {
      console.error(`Screen ${layout.screen} not found. Available screens: ${screens.length}`)
      for (const s of screens) {
        console.error(`  Screen ${s.index}: ${s.w}x${s.h} at (${s.x}, ${s.y})${s.isMain ? ' (main)' : ''}`)
      }
      process.exit(1)
    }
    const screen = screens[layout.screen]
    console.log(`Using screen ${screen.index}: ${screen.w}x${screen.h}${screen.isMain ? ' (main)' : ''}`)

    // Calculate layout geometry
    const { windowFrames, recordingRect } = calculateLayoutGeometry(
      screen,
      layout.padding,
      layout.windows.length,
      layout.recording,
    )

    // Arrange windows
    console.log('Arranging windows...')
    for (let i = 0; i < layout.windows.length; i++) {
      const slot = layout.windows[i]
      const frame = windowFrames[i]

      // Determine which frame to use based on position
      let targetFrame = frame
      if (layout.windows.length === 2) {
        if (slot.position === 'left') targetFrame = windowFrames[0]
        else if (slot.position === 'right') targetFrame = windowFrames[1]
      }

      // Launch app if not running
      const running = await isAppRunning(slot.app)
      if (!running) {
        console.log(`  Launching ${slot.app}...`)
        await launchApp(slot.app)
        await sleep(1000) // Wait for app to start
      }

      console.log(`  Moving ${slot.app} to ${slot.position} (${Math.round(targetFrame.w)}x${Math.round(targetFrame.h)})`)
      await setWindowFrame(slot.app, targetFrame)
      await sleep(200) // Small delay between window operations
    }

    // Focus the last window
    const lastApp = layout.windows[layout.windows.length - 1]
    await activateApp(lastApp.app)

    // Wait for windows to settle
    await sleep(500)

    // Start recording
    const outputPath = generateOutputPath(options.output)

    console.log(`Recording to: ${outputPath}`)
    console.log(`Audio: ${audio ? 'on (default mic)' : 'off'}`)
    console.log(`Press Ctrl+C to stop recording\n`)

    const ffmpeg = await startRecording({
      screenIndex: screen.index,
      screenFrame: screen,
      crop: recordingRect,
      audio,
      outputPath,
      crf: options.crf,
    })

    // Log ffmpeg stderr for debugging
    ffmpeg.stderr?.on('data', (data: Buffer) => {
      const line = data.toString().trim()
      // Only show important lines, skip the verbose frame output
      if (line.startsWith('frame=') || line.startsWith('size=')) return
      if (line.includes('Error') || line.includes('error') || line.includes('Warning')) {
        console.error(`ffmpeg: ${line}`)
      }
    })

    // Handle ffmpeg exit (unexpected crash)
    ffmpeg.on('close', (code) => {
      if (code !== 0 && code !== 255) {
        console.error(`\nffmpeg exited with code ${code}`)
      }
    })

    // Handle Ctrl+C gracefully
    let stopping = false
    const cleanup = async () => {
      if (stopping) return
      stopping = true

      console.log('\nStopping recording...')
      await stopRecording(ffmpeg)

      // Wait a moment for file to be fully written
      await sleep(1000)

      console.log(`Saved: ${outputPath}`)
      revealInFinder(outputPath)

      // Give Finder a moment to open, then exit
      await sleep(500)
      process.exit(0)
    }

    process.on('SIGINT', cleanup)
    process.on('SIGTERM', cleanup)

    // Keep the process alive while ffmpeg runs
    await new Promise<void>((resolve) => {
      ffmpeg.on('close', resolve)
    })
  })

cli.help()
cli.version(pkg.version)
cli.parse()

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
