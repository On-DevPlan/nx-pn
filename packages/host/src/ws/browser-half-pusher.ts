/**
 * Browser-half pusher — sends compiled browser-half source over WS as a
 * `browser-half.load` frame. Spec §5.2 / §4.5.1.
 *
 * Uses the WsHostServer.forEach API so every connected socket receives
 * the push.
 */

import type { WsHostServer } from './ws-server.js'

export interface BrowserHalfPusherDeps {
  ws: WsHostServer
}

export class BrowserHalfPusher {
  constructor(private readonly deps: BrowserHalfPusherDeps) {}

  /** Push a newly-compiled browser half. */
  load(args: { id: string; pluginRunId: string; code: string }): boolean {
    let delivered = false
    this.deps.ws.forEach((_ws, bridge) => {
      const ok = bridge.sendNotification('browser-half.load', args)
      delivered = delivered || ok
    })
    return delivered
  }

  /** Notify the browser a plugin has been retracted. */
  retract(pluginRunId: string, id?: string): void {
    this.deps.ws.forEach((_ws, bridge) => {
      bridge.sendNotification('browser-half.retract', { pluginRunId, ...(id !== undefined ? { id } : {}) })
    })
  }
}