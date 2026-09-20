/** Run ONLY against a disposable dsh web profile. DSH_IMAGE_TEST_URL supplies its authenticated URL. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, readFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

if (!process.env.DSH_IMAGE_TEST_URL || process.env.DSH_IMAGE_TEST_ISOLATED !== '1') throw new Error('Set DSH_IMAGE_TEST_URL and DSH_IMAGE_TEST_ISOLATED=1 for a disposable profile only.')
const require = createRequire(path.join(process.env.IMAGE_QA_MODULES ?? path.join(os.tmpdir(), 'dsh-image-generation-qa'), 'package.json'))
const { chromium } = require('playwright')
const artifacts = await mkdtemp(path.join(os.tmpdir(), 'dsh-image-live-'))
const png = 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAHklEQVQ4jWPo23H3PyWYYdSA/6NhcHc0DHYMizAAALd0Ii6qzJXIAAAAAElFTkSuQmCC'
const requests = []
const server = createServer(async (req, res) => {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const body = Buffer.concat(chunks).toString()
  requests.push({ url: req.url, auth: req.headers.authorization, body: body ? JSON.parse(body) : undefined })
  res.setHeader('Content-Type', 'application/json')
  if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id: 'test-image-model' }, { id: 'chat-only' }] }))
  res.end(JSON.stringify({ data: [{ b64_json: png }] }))
})
server.listen(0, '127.0.0.1'); await once(server, 'listening')
const browser = await chromium.launch({ channel: 'msedge', headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 940 }, acceptDownloads: true })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(process.env.DSH_IMAGE_TEST_URL)
  await page.getByRole('button', { name: '设置', exact: true }).waitFor()
  await page.waitForTimeout(500)
  for (const name of ['继续', '稍后配置']) {
    const button = page.getByRole('button', { name, exact: true })
    if (await button.isVisible()) { await button.click(); await page.waitForTimeout(400) }
  }
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByText('绘图', { exact: true }).click()
  await page.getByRole('button', { name: '添加模型', exact: true }).click()
  const id = `smoke-${Date.now()}`
  await page.getByText('高级设置（可选）', { exact: true }).click()
  await page.getByLabel('配置 ID', { exact: true }).fill(id)
  await page.getByLabel('供应商 API 地址').fill(`http://127.0.0.1:${server.address().port}/v1`)
  await page.getByLabel('凭据引用', { exact: true }).fill('SMOKE_IMAGE_KEY')
  await page.getByLabel('API Key（留空保留现有值）').fill('smoke-key')
  await page.getByRole('button', { name: '获取模型列表', exact: true }).click()
  await page.getByLabel('搜索供应商模型').fill('image')
  await page.getByRole('button', { name: 'test-image-model', exact: true }).click()
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await page.getByText('已保存，下次生成即生效。').waitFor()
  await page.locator('.ig-page select').selectOption(id)
  await page.getByLabel('提示词', { exact: true }).fill('本地测试图片，不调用真实服务')
  await page.getByRole('button', { name: '生成图片', exact: true }).click()
  await page.getByRole('button', { name: '下载原图', exact: true }).waitFor()
  await page.waitForFunction(() => { const image = document.querySelector('.ig-card img'); return image?.complete && image.naturalWidth > 0 })
  const downloaded = page.waitForEvent('download')
  await page.getByRole('button', { name: '下载原图', exact: true }).click()
  const download = await downloaded
  const downloadedPath = path.join(artifacts, download.suggestedFilename())
  await download.saveAs(downloadedPath)
  assert.equal((await readFile(downloadedPath)).toString('base64'), png)
  assert.equal(requests.length, 2)
  assert.equal(requests[0].url, '/v1/models')
  assert.equal(requests[0].auth, 'Bearer smoke-key')
  assert.equal(requests[1].url, '/v1/images/generations')
  assert.equal(requests[1].auth, 'Bearer smoke-key')
  assert.equal(requests[1].body.model, 'test-image-model')
  assert.deepEqual(errors, [])
  await page.screenshot({ path: path.join(artifacts, 'live.png'), fullPage: true })
  console.log(`PASS isolated dsh profile: bundle/client loading, real settings + credentials + Remote gateway, HTTP generation, attachment preview and exact original download. Artifacts: ${artifacts}`)
} finally { await browser.close(); server.closeAllConnections(); server.close() }
