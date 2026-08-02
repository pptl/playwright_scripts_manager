import { app, BrowserWindow, shell } from 'electron'
import { join } from 'path'
import { registerIpcHandlers } from './ipc/ipcHandlers'
import { IPC_CHANNELS } from '../shared/types'
import { loadSettings, hasWorkspace } from './storage/workspace'
import { load as loadVault } from './security/vault'

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

  // The workspace lives in the user's own git repo, so it can change under us
  // while the app is open (a pull, a branch switch). Regaining focus is the
  // moment right after the user did that in a terminal — cheap, and it covers
  // the case that would otherwise be silently overwritten by the next autosave.
  // Guarded on hasWorkspace: this also fires for the initial win.focus() below,
  // when there is nothing to reload and storage would throw.
  win.on('focus', () => {
    if (hasWorkspace()) win.webContents.send(IPC_CHANNELS.WORKSPACE_RELOAD)
  })

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

app.whenReady().then(async () => {
  // Must precede the window: the renderer asks for the workspace on mount, and
  // storage throws until one is set.
  await loadSettings()
  // Read the vault metadata (and try the remembered passphrase) before any IPC can run,
  // so the locked-state guards are never answering from an unloaded state.
  await loadVault()

  const win = createWindow()
  registerIpcHandlers(win)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
