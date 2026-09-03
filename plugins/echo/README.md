# echo — user-driven request tester

A second demo plugin for **api-audit**. Unlike `example-api` (which fires
one fixed GET on activation), the echo plugin provides a form-driven page
where the user picks an HTTP method, types a URL, headers, and body, and
the form dispatches the request through the core unified `auditClient`.
Every call shows up in the audit log with `initiator: "echo"` and is
replayable from the audit page.

## What it proves

- User-driven (not activation-time) auditClient calls from the browser
- POST / PUT / PATCH / DELETE verbs all work through the same proxy
- Multi-plugin coexistence: the sidebar shows both `示例 API` and `Echo 测试`
- Each echo request is a normal `AuditRecord` — go to `/replay`, pick the
  record, edit the request, re-run

## Install

Build the zip and upload via the web UI (Plugins page → 上传 zip):

```bash
cd plugins/echo
node scripts/build-zip.mjs    # produces dist/echo.zip
```

Or via REST:

```bash
curl -F "zip=@dist/echo.zip" http://localhost:4560/api/plugins
```

After upload, the sidebar will show **Echo 测试** under 插件页面. Click it,
fill in the form, hit 发送 — the request lands in `/audit` attributed to
`echo`. The record is replayable from `/replay` (editable method, URL,
headers, body).
