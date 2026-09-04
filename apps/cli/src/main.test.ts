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

  it('add <spec> sets the subcommand + spec', () => {
    const opts = parseArgs(['add', '@scope/my-audit-plugin'])
    expect(opts.subcommand).toBe('add')
    expect(opts.spec).toBe('@scope/my-audit-plugin')
    expect(opts.port).toBe(DEFAULT_PORT)
  })

  it('add accepts name@version and file: specs', () => {
    expect(parseArgs(['add', 'pkg@1.2.3']).spec).toBe('pkg@1.2.3')
    expect(parseArgs(['add', '--data-dir', 'x', 'file:./folder']).spec).toBe('file:./folder')
  })

  it('add without a spec throws', () => {
    expect(() => parseArgs(['add'])).toThrow(/requires a plugin spec/)
    expect(() => parseArgs(['add', '--no-open'])).toThrow(/requires a plugin spec/)
  })

  it('add rejects extra positionals', () => {
    expect(() => parseArgs(['add', 'pkg', 'extra'])).toThrow(/unexpected argument/)
  })

  it('uninstall <id|runId> sets the subcommand + pluginId', () => {
    const opts = parseArgs(['uninstall', 'run-3'])
    expect(opts.subcommand).toBe('uninstall')
    expect(opts.pluginId).toBe('run-3')
    expect(parseArgs(['uninstall', 'my-plugin']).pluginId).toBe('my-plugin')
  })

  it('uninstall without an id throws', () => {
    expect(() => parseArgs(['uninstall'])).toThrow(/requires a plugin id/)
  })

  it('unknown subcommands throw with a hint', () => {
    expect(() => parseArgs(['fritz'])).toThrow(/unknown argument/)
  })
})

describe('init <name>', () => {
  it('sets subcommand=init and pluginName', () => {
    const opts = parseArgs(['init', 'my-plugin'])
    expect(opts.subcommand).toBe('init')
    expect(opts.pluginName).toBe('my-plugin')
  })

  it('--dir resolves to absolute', () => {
    expect(parseArgs(['init', 'x', '--dir', 'rel/dir']).initDir).toBe(resolve('rel/dir'))
  })

  it('--dir= accepts inline value', () => {
    expect(parseArgs(['init', 'x', '--dir=/tmp/x']).initDir).toBe(resolve('/tmp/x'))
  })

  it('--force and -f enable overwrite', () => {
    expect(parseArgs(['init', 'x', '--force']).force).toBe(true)
    expect(parseArgs(['init', 'x', '-f']).force).toBe(true)
  })

  it('rejects missing name', () => {
    expect(() => parseArgs(['init'])).toThrow(/requires a plugin name/)
  })

  it('rejects extra positionals', () => {
    expect(() => parseArgs(['init', 'x', 'extra'])).toThrow(/unexpected argument/)
  })
})
