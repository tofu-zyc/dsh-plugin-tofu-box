/**
 * Regression guard for a bug that no engine test could catch.
 *
 * The stage owns pointerdown/move/up so the map can be panned and painted, and
 * it calls preventDefault() on pointerdown. Buttons rendered INSIDE the stage
 * (the first-run guide's "Got it", the save notice, the empty-world restock)
 * therefore never received a click: preventDefault on pointerdown cancels the
 * compatibility mouse events. The handlers now ignore any press that starts on
 * chrome, and this suite pins that decision table.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { boot } from './_harness.mjs'

const { seam } = boot()
const { isStageControl, STAGE_CONTROLS } = seam

/** A DOM-ish target whose closest() reports the given class. */
const targetIn = (...classes) => ({
  closest(selector) {
    return classes.some(name => selector.includes(name)) ? { className: classes.join(' ') } : null
  },
})

test('every interactive overlay the panel renders inside the stage is covered', () => {
  for (const selector of ['.pe-onboard', '.pe-notice', '.pe-emptyworld', '.pe-modal', '.pe-inspector', '.pe-eventbar']) {
    assert.ok(STAGE_CONTROLS.includes(selector), selector + ' must be exempt from the stage handlers')
  }
})

test('a press on a card is chrome, not a stroke on the map', () => {
  for (const name of ['.pe-onboard', '.pe-notice', '.pe-emptyworld', '.pe-modal']) {
    assert.equal(isStageControl(targetIn(name)), true, name + ' must not reach the stage handlers')
  }
})

test('a press on the canvas is still a stroke', () => {
  assert.equal(isStageControl(targetIn('.pe-canvas')), false)
  assert.equal(isStageControl({ closest: () => null }), false)
})

test('a pointer event with no usable target is treated as the map', () => {
  assert.equal(isStageControl(null), false)
  assert.equal(isStageControl(undefined), false)
  assert.equal(isStageControl({}), false, 'a target without closest() must not crash the handler')
})
