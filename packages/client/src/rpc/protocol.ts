/**
 * Protocol frame constants shared between host and browser. Mirror of
 * `packages/host/src/ws/rpc-bridge.ts` — the browser side is a separate
 * WebSocket transport with the SAME wire format so host can talk to it.
 * Spec §4.5.1.
 */

/** 16 MB hard frame ceiling. */
export const MAX_FRAME_BYTES = 16 * 1024 * 1024

export const RPC_DEFAULT_TIMEOUT_MS = 30_000

/** Outbound size-limit error code. */
export const FRAME_TOO_LARGE_CODE = 'payload/too-large'
/** Socket disconnected while a request was pending. */
export const RPC_DISCONNECTED_CODE = 'rpc/disconnected'

export type RpcOp =
  | 'snapshot.request'
  | 'snapshot.respond'
  | 'audit.append'
  | 'plugin.changed'
  | 'rpc.invoke'
  | 'rpc.result'
  | 'browser-half.load'
  | 'browser-half.retract'
  | 'error'

export interface RpcFrame {
  v: 1
  generation: number
  requestId: string
  op: RpcOp
  payload: unknown
}
