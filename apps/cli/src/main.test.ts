import { describe, it, expect } from 'vitest'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { DEFAULT_PORT, parseArgs, CliArgError, forwardInstall } from './main.js'
import { probeHost } from './probe.js'

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

describe('probeHost (add → live-host forwarding)', () => {
  it('returns false when nothing listens on the port', async () => {
    // Port 1 is almost certainly closed; the fetch fails fast (ECONNREFUSED).
    const alive = await probeHost(1)
    expect(alive).toBe(false)
  })

  it('returns true when a host responds 200 on /api/plugins', async () => {
    const { createServer } = await import('node:http')
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":true,"data":[]}')
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    try {
      const port = (server.address() as { port: number }).port
      expect(await probeHost(port)).toBe(true)
    } finally {
      await new Promise<void>((r) => server.close(() => r()))
    }
  })
})

describe('forwardInstall (add → live-host forwarding)', () => {
  it('POSTs {spec} to /api/plugins/install and returns the data payload', async () => {
    const { createServer } = await import('node:http')
    const bodies: string[] = []
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = []
      for await (const c of req) chunks.push(c as Buffer)
      bodies.push(Buffer.concat(chunks).toString('utf-8'))
      res.writeHead(201, { 'content-type': 'application/json' })
      res.end('{"ok":true,"data":{"id":"demo","pluginRunId":"run-9","version":"0.1.0"}}')
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    try {
      const port = (server.address() as { port: number }).port
      const r = await forwardInstall(port, 'file:./demo')
      expect(r).toEqual({ id: 'demo', pluginRunId: 'run-9', version: '0.1.0' })
      expect(JSON.parse(bodies[0]!)).toEqual({ spec: 'file:./demo' })
    } finally {
      await new Promise<void>((r) => server.close(() => r()))
    }
  })

  it('throws with the error code on a non-2xx / ok:false reply', async () => {
    const { createServer } = await import('node:http')
    const server = createServer((_req, res) => {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end('{"ok":false,"error":{"code":"install/invalid-manifest","message":"bad manifest"}}')
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    try {
      const port = (server.address() as { port: number }).port
      await expect(forwardInstall(port, 'file:./broken')).rejects.toThrow(/install\/invalid-manifest/)
    } finally {
      await new Promise<void>((r) => server.close(() => r()))
    }
  })
})

describe('audit list|lastId', () => {
  it('audit list defaults to list action', () => {
    const opts = parseArgs(['audit', 'list'])
    expect(opts.subcommand).toBe('audit')
    expect(opts.auditAction).toBe('list')
  })

  it('bare `audit` means list', () => {
    const opts = parseArgs(['audit'])
    expect(opts.subcommand).toBe('audit')
    expect(opts.auditAction).toBe('list')
  })

  it('audit lastId sets action', () => {
    expect(parseArgs(['audit', 'lastId']).auditAction).toBe('lastId')
  })

  it('parses query flags', () => {
    const opts = parseArgs(['audit', 'list', '--method', 'GET', '--status', '200', '--url', 'api', '--initiator', 'echo', '--limit', '50', '--order', 'asc', '--since-id', '3', '--format', 'jsonl'])
    expect(opts.auditQuery).toEqual({
      sinceId: 3,
      method: 'GET',
      status: 200,
      url: 'api',
      initiator: 'echo',
      limit: 50,
      order: 'asc',
    })
    expect(opts.format).toBe('jsonl')
  })

  it('rejects bad order / format', () => {
    expect(() => parseArgs(['audit', 'list', '--order', 'sideways'])).toThrow(/order/)
    expect(() => parseArgs(['audit', 'list', '--format', 'xml'])).toThrow(/format/)
  })

  it('rejects unknown audit actions', () => {
    expect(() => parseArgs(['audit', 'purge'])).toThrow(/audit action/)
  })
})

describe('plugin list|show|stop|remove|uninstall', () => {
  it('plugin list', () => {
    const opts = parseArgs(['plugin', 'list'])
    expect(opts.subcommand).toBe('plugin')
    expect(opts.pluginAction).toBe('list')
  })

  it('plugin show|stop|remove|uninstall take a target', () => {
    expect(parseArgs(['plugin', 'show', 'echo']).pluginTarget).toBe('echo')
    expect(parseArgs(['plugin', 'stop', 'run-7']).pluginTarget).toBe('run-7')
    expect(parseArgs(['plugin', 'remove', 'run-7']).pluginAction).toBe('remove')
    expect(parseArgs(['plugin', 'uninstall', 'echo']).pluginTarget).toBe('echo')
  })

  it('plugin action requires a target for non-list', () => {
    expect(() => parseArgs(['plugin', 'stop'])).toThrow(/requires a plugin id/)
  })

  it('plugin with no action throws', () => {
    expect(() => parseArgs(['plugin'])).toThrow(/plugin requires an action/)
  })
})

describe('build <dir>', () => {
  it('sets buildDir to an absolute path', () => {
    const opts = parseArgs(['build', 'plugins/my-plugin'])
    expect(opts.subcommand).toBe('build')
    expect(opts.buildDir).toBe(resolve('plugins/my-plugin'))
  })

  it('requires a directory', () => {
    expect(() => parseArgs(['build'])).toThrow(/requires a plugin directory/)
  })
})
