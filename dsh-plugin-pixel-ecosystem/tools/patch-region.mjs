
import { readFileSync, writeFileSync } from 'node:fs'

const [target, startMarker, endMarker, replacementFile] = process.argv.slice(2)
let source = readFileSync(target, 'utf8')
const start = source.indexOf(startMarker)
const end = source.indexOf(endMarker)
if (start < 0) throw new Error('start marker not found: ' + startMarker)
if (end < 0) throw new Error('end marker not found: ' + endMarker)
if (end < start) throw new Error('end marker is before start marker')
const replacement = readFileSync(replacementFile, 'utf8')
source = source.slice(0, start) + replacement + source.slice(end)
writeFileSync(target, source)
console.log('patched', target, 'region', start, '->', end, 'replaced with', replacement.length, 'chars')
