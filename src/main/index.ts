import { app, BrowserWindow, shell } from 'electron'
import { join } from 'path'
import { registerIpcHandlers } from './ipc/ipcHandlers'

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    title: 'FlowTest',
    show: false,
  })

  // Open external links in the default browser, not Electron
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  win.on('ready-to-show', () => {
    win.show()
    // Windows can deny SetForegroundWindow if too much time passed since the
    // launching terminal's last keystroke (common on a cold boot, when GPU/AV
    // warmup slows startup past the OS's foreground grace period). Toggling
    // alwaysOnTop uses a different focus path that isn't subject to that lock.
    win.setAlwaysOnTop(true)
    win.focus()
    win.setAlwaysOnTop(false)
  })

  return win
}

app.whenReady().then(() => {
  const win = createWindow()
  registerIpcHandlers(win)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
