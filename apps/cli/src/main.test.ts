import { describe, it, expect } from 'vitest'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { DEFAULT_PORT, parseArgs, CliArgError } from './main.js'

describe('parseArgs (spec §2.2)', () => {
  it('defaults: port 4560, ~/.api-audit, open', () => {
    const opts = parseArgs([])
    expect(opts.port).toBe(DEFAULT_PORT)
    expect(opts.port).toBe(4560)
    expect(opts.dataDir).toBe(join(homedir(), '.api-audit'))
    expect(opts.open).toBe(true)
  })

  it('--port accepts a separated value', () => {
    expect(parseArgs(['--port', '5099']).port).toBe(5099)
  })

  it('--port= accepts an inline value', () => {
    expect(parseArgs(['--port=8080']).port).toBe(8080)
  })

  it('rejects a non-integer / out-of-range port', () => {
    expect(() => parseArgs(['--port', 'abc'])).toThrow(CliArgError)
    expect(() => parseArgs(['--port', '70000'])).toThrow(CliArgError)
    expect(() => parseArgs(['--port'])).toThrow(/missing value/)
  })

  it('--data-dir resolves to an absolute path', () => {
    const opts = parseArgs(['--data-dir', 'some/rel/dir'])
    expect(opts.dataDir).toBe(resolve('some/rel/dir'))
    expect(parseArgs(['--data-dir=/tmp/aa']).dataDir).toBe(resolve('/tmp/aa'))
  })

  it('--data-dir without a value throws', () => {
    expect(() => parseArgs(['--data-dir'])).toThrow(/missing value/)
  })

  it('--no-open disables the browser', () => {
    expect(parseArgs(['--no-open']).open).toBe(false)
    expect(parseArgs(['--no-open', '--port', '1']).open).toBe(false)
  })

  it('unknown arguments throw with a hint', () => {
    expect(() => parseArgs(['--wat'])).toThrow(/unknown argument/)
    expect(() => parseArgs(['extra-positional'])).toThrow(/unknown argument/)
  })

  it('combines flags', () => {
    const opts = parseArgs(['--port=0', '--data-dir=x', '--no-open'])
    expect(opts).toEqual({ port: 0, dataDir: resolve('x'), open: false })
  })
})
