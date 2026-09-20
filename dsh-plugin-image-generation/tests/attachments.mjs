/** Integration with the installed dsh attachment backend; all writes use a new temp home. */
import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { generateImages } from '../core.js'
import { Config } from '../index.js'

const entry = process.env.DSH_ATTACHMENT_MODULE ?? path.join(os.homedir(), '.dsh/profiles/node_modules/@deepseek-ai/dsh-attachment-local/lib/index.js')
const { LocalAttachmentStore } = await import(pathToFileURL(entry).href)
const home = await mkdtemp(path.join(os.tmpdir(), 'dsh-image-attachments-'))
const ctx = { reflect: { provide() {} }, effect() {}, get() {} }
const attachments = new LocalAttachmentStore(ctx, { dshHome: home })
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAHklEQVQ4jWPo23H3PyWYYdSA/6NhcHc0DHYMizAAALd0Ii6qzJXIAAAAAElFTkSuQmCC', 'base64')
const result = await generateImages({
  config: Config({ models: [{ id: 'test', model: 'test-image' }] }), args: { prompt: 'test' },
  attachments, resolveKey: async () => undefined,
  fetchImpl: async () => Response.json({ data: [{ b64_json: png.toString('base64') }] }),
})
assert.deepEqual(await readFile(result.images[0].path), png)
const image = await attachments.readImage(result.images[0].preview)
assert.equal(image.ref.width, 16)
const chunks = []
for await (const chunk of attachments.readFileStream(result.images[0].original)) chunks.push(chunk)
assert.deepEqual(Buffer.concat(chunks), png)
console.log(`PASS installed dsh attachment backend: preview decodes, original file and download stream are exact. Temp home: ${home}`)
