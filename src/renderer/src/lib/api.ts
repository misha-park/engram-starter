import type { IpcChannel, IpcContract } from '@shared/ipc'

/** Typed call into the main process. */
export function call<C extends IpcChannel>(
  channel: C,
  ...args: IpcContract[C]['args']
): Promise<IpcContract[C]['result']> {
  return window.api.invoke(channel, ...args)
}

export const onEvent = window.api.on
