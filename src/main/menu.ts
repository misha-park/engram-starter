import { app, Menu, type MenuItemConstructorOptions } from 'electron'

/**
 * The macOS menu bar: Engram's own app menu (About, Settings… ⌘,), the standard Edit menu
 * (copy and paste in every text field) and Window menu. Reload and the developer tools are
 * only there in development, so ⌘R can't reload the app halfway through something.
 */
export function setAppMenu(options: { dev: boolean; openPage(path: string): void }): void {
  app.setAboutPanelOptions({
    applicationName: 'Engram',
    applicationVersion: app.getVersion(),
    credits: 'A personal study planner.'
  })
  const template: MenuItemConstructorOptions[] = [
    {
      label: 'Engram',
      submenu: [
        { role: 'about', label: 'About Engram' },
        { type: 'separator' },
        {
          label: 'Settings…',
          accelerator: 'CmdOrCtrl+,',
          click: () => options.openPage('/settings')
        },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide', label: 'Hide Engram' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit', label: 'Quit Engram' }
      ]
    },
    { role: 'fileMenu' },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        ...(options.dev
          ? ([
              { role: 'reload' },
              { role: 'forceReload' },
              { role: 'toggleDevTools' },
              { type: 'separator' }
            ] as MenuItemConstructorOptions[])
          : []),
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    { role: 'windowMenu' }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
