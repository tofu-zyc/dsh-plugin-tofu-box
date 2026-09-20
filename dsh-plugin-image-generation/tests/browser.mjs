/** Browser contract test. Supply IMAGE_QA_MODULES with playwright/react/react-dom/esbuild installed. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFile, mkdtemp, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { once } from 'node:events'
import path from 'node:path'
import os from 'node:os'

const qaDir = process.env.IMAGE_QA_MODULES ?? path.join(os.tmpdir(), 'dsh-image-generation-qa')
const require = createRequire(path.join(qaDir, 'package.json'))
const { chromium } = require('playwright')
const { build } = require('esbuild')
const artifactDir = await mkdtemp(path.join(os.tmpdir(), 'dsh-image-browser-'))
const script = await readFile(new URL('../client.js', import.meta.url), 'utf8')
const png = 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAHklEQVQ4jWPo23H3PyWYYdSA/6NhcHc0DHYMizAAALd0Ii6qzJXIAAAAAElFTkSuQmCC'
const fixture = `
import React from 'react'; import { createRoot } from 'react-dom/client';
let value = {models:[], defaultModel:''}, revision=0;
window.calls=[]; window.sections=[]; window.keySaved=false;
const ok=value=>({ok:true,value});
const ref={attachmentId:'preview',mediaType:'image/png',width:1,height:1,bytes:68,name:'generated.png'};
const result={model:'art',images:[{preview:ref,original:{attachmentId:'original',name:'generated.png',bytes:68},mediaType:'image/png',path:'D:/attachments/generated.png'}]};
const remote={settings:{
  async describe(){return ok({writable:true,namespaces:[{ns:'image-generation',value,revision}]})},
  async mutate(ns,ops,expected){
    if(expected!==revision) return {ok:false,error:{message:'revision conflict'}};
    for(const op of ops) value={...value,[op.path[0]]:op.value}; revision++;
    window.saved=JSON.parse(JSON.stringify(value));return ok({});
  }
},credentials:{async set(ref,key){window.keySaved=ref==='IMAGE_API_KEY' && key==='test-secret';return ok()}}};
const ctx={remote,effect(fn){fn()},slots:{inject(_name,fn){fn()},register(meta,render){
  if(meta.name==='settings.section') {window.sections.push(meta.id);createRoot(document.getElementById('root')).render(render())}
}},connection:{rpc:{async call(_base,route,payload){
  window.calls.push({route,payload});
  if(route.endsWith('/discover')) return ok({models:[{id:'chat-only',name:'聊天模型'},{id:'my-image-alias',name:'绘图模型别名'}],truncated:false});
  if(route.endsWith('/start')) return ok({jobId:'test-job'});
  if(route.endsWith('/status')) return ok({status:'done',result});
  if(route.endsWith('/image')) return ok({data:'${png}',mediaType:'image/png',name:'generated.png'});
  if(route.endsWith('/cancel')) return ok({cancelled:true});
  throw new Error(route);
}}}};
window.__ModuleLoader__={load(def){def.factory(name=>{if(name==='react')return React;throw new Error(name)}).apply(ctx)}};
${script}
`
const bundled = await build({ stdin: { contents: fixture, resolveDir: qaDir, loader: 'js' }, bundle: true, write: false, format: 'iife', define: { 'process.env.NODE_ENV': '"development"' } })
const server = createServer((req, res) => {
  if (req.url === '/app.js') { res.setHeader('content-type', 'text/javascript'); res.end(bundled.outputFiles[0].text) }
  else { res.setHeader('content-type', 'text/html; charset=utf-8'); res.end('<html lang="zh"><meta charset="utf-8"><style>body{font:14px system-ui;margin:24px;background:#fafafa;color:#222}#root{max-width:920px;margin:auto}</style><div id="root"></div><script src="/app.js"></script></html>') }
})
server.listen(0, '127.0.0.1'); await once(server, 'listening')
const browser = await chromium.launch({ channel: 'msedge', headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 1120, height: 1000 }, acceptDownloads: true })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(`http://127.0.0.1:${server.address().port}`)
  await page.getByRole('button', { name: '添加模型', exact: true }).click()
  await page.getByLabel('API Key（留空保留现有值）', { exact: true }).fill('test-secret')
  assert.equal(await page.getByLabel('供应商 API 地址').inputValue(), 'https://api.openai.com/v1')
  await page.getByRole('button', { name: '获取模型列表', exact: true }).click()
  await page.getByLabel('搜索供应商模型').fill('绘图')
  await page.getByRole('button', { name: '绘图模型别名 · my-image-alias', exact: true }).click()
  assert.equal(await page.getByLabel('模型 ID', { exact: true }).inputValue(), 'my-image-alias')
  assert.equal(await page.evaluate(() => window.keySaved), false)
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await page.getByText('已保存，下次生成即生效。').waitFor()
  assert.equal(await page.evaluate(() => window.keySaved), true)
  const saved = await page.evaluate(() => window.saved)
  assert.equal(saved.defaultModel, 'my-image-alias')
  assert.equal(saved.models[0].model, 'my-image-alias')
  assert.doesNotMatch(JSON.stringify(saved), /test-secret/)
  await page.getByLabel('提示词', { exact: true }).fill('蓝天白云下的小猫')
  await page.getByRole('button', { name: '生成图片', exact: true }).click()
  await page.getByRole('button', { name: '下载原图', exact: true }).waitFor()
  await page.locator('.ig-card img').waitFor()
  await page.screenshot({ path: path.join(artifactDir, 'desktop.png'), fullPage: true })
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: '下载原图', exact: true }).click()
  const download = await downloadPromise
  const output = path.join(artifactDir, download.suggestedFilename())
  await download.saveAs(output)
  assert.equal((await readFile(output)).toString('base64'), png)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('button', { name: '编辑', exact: true }).click()
  await page.getByRole('button', { name: '获取模型列表', exact: true }).click()
  await page.getByLabel('供应商 API 地址').fill('https://another.example/v1')
  assert.equal(await page.getByLabel('搜索供应商模型').count(), 0)
  await page.screenshot({ path: path.join(artifactDir, 'mobile.png'), fullPage: true })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true)
  await page.getByRole('button', { name: '取消', exact: true }).click()
  await page.reload()
  await page.getByRole('button', { name: '下载原图', exact: true }).waitFor()
  assert.deepEqual(errors, [])
  const calls = await page.evaluate(() => window.calls)
  await writeFile(path.join(artifactDir, 'report.json'), JSON.stringify({ saved, calls, errors }, null, 2))
  console.log(`PASS browser: settings, separate credentials, generation, original download, mobile layout, job restore. Artifacts: ${artifactDir}`)
} finally { await browser.close(); server.closeAllConnections(); server.close() }
