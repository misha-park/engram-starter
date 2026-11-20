import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { IPC_CHANNELS, IPC_EVENTS, type WindowApi } from '../shared/ipc'

// Runs sandboxed: only `electron` may be required here; everything else is bundled.
// Only channels in the shared contract are forwarded.

const channels = new Set<string>(IPC_CHANNELS)
const events = new Set<string>(IPC_EVENTS)

const api: WindowApi = {
  invoke: (channel, ...args) => {
    if (!channels.has(channel)) return Promise.reject(new Error(`Unknown channel: ${channel}`))
    return ipcRenderer.invoke(channel, ...args)
  },
  on: (event, listener) => {
    if (!events.has(event)) throw new Error(`Unknown event: ${event}`)
    const wrapped = (_e: Electron.IpcRendererEvent, ...args: unknown[]): void =>
      (listener as (...a: unknown[]) => void)(...args)
    ipcRenderer.on(event, wrapped)
    return () => ipcRenderer.removeListener(event, wrapped)
  },
  pathForFile: (file) => webUtils.getPathForFile(file)
}

contextBridge.exposeInMainWorld('api', api)
