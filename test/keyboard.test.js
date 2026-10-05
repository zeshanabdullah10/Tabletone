import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Keyboard, SCALES, noteName } from '../src/keyboard.js';
import { handPts, placedKeyboard } from './sim.js';

const trapezoid = () => { const kb = new Keyboard(); kb.setQuad({ nl: { x: 200, y: 300 }, nr: { x: 1100, y: 320 }, fr: { x: 1200, y: 600 }, fl: { x: 100, y: 580 } }, 1280, 720); return kb; };

test('uv() inverts point() across the whole quad (perspective trapezoid)', () => {
  const kb = trapezoid();
  for (let u = 0; u <= 1; u += 0.05) for (let v = -0.2; v <= 1.2; v += 0.1) {
    const p = kb.point(u, v), r = kb.uv(p.x, p.y);
    assert.ok(Math.abs(r.u - u) < 1e-9 && Math.abs(r.v - v) < 1e-9, `u=${u} v=${v} → ${JSON.stringify(r)}`);
  }
});

test('uv() also works for a parallelogram and an upside-down quad', () => {
  for (const quad of [
    { nl: { x: 0, y: 0 }, nr: { x: 100, y: 0 }, fr: { x: 120, y: 50 }, fl: { x: 20, y: 50 } },      // k2 = 0 branch
    { nl: { x: 100, y: 600 }, nr: { x: 1100, y: 600 }, fr: { x: 1000, y: 300 }, fl: { x: 200, y: 300 } },
  ]) {
    const kb = new Keyboard(); kb.setQuad(quad, 1280, 720);
    for (const [u, v] of [[0.1, 0.1], [0.5, 0.5], [0.9, 0.95]]) {
      const p = kb.point(u, v), r = kb.uv(p.x, p.y);
      assert.ok(Math.abs(r.u - u) < 1e-9 && Math.abs(r.v - v) < 1e-9);
    }
  }
});

test('keyAt maps each key centre to its index and rejects points outside', () => {
  const kb = trapezoid();
  for (let i = 0; i < kb.count; i++) { const p = kb.point((i + 0.5) / kb.count, 0.5); assert.equal(kb.keyAt(p.x, p.y), i); }
  assert.equal(kb.keyAt(10, 10), null);
  const left = kb.point(-0.01, 0.5); assert.equal(kb.keyAt(left.x, left.y), null);
  const right = kb.point(1.0, 0.5); assert.equal(kb.keyAt(right.x, right.y), null, 'u = 1 is outside (no key 8)');
  const deep = kb.point(0.5, 1.4); assert.equal(kb.keyAt(deep.x, deep.y), null);
  const slack = kb.point(0.5, 1.2); assert.notEqual(kb.keyAt(slack.x, slack.y), null, 'some depth slack');
});

test('keyAt returns null with no keyboard and for degenerate quads', () => {
  const kb = new Keyboard();
  assert.equal(kb.keyAt(1, 1), null);
  kb.setQuad({ nl: { x: 5, y: 5 }, nr: { x: 5, y: 5 }, fr: { x: 5, y: 5 }, fl: { x: 5, y: 5 } }, 100, 100);
  assert.equal(kb.keyAt(5, 5), null);
});

test('quadFromHands spans the outer fingertips; fingers point down the image', () => {
  const l = { pts: handPts(300, 300, 70) }, r = { pts: handPts(950, 300, 70, { mirror: true }) };
  const q = Keyboard.quadFromHands(l, r);
  assert.ok(q.nl.x < 300 && q.nr.x > 950, 'ends at outer fingertips');
  assert.ok(q.fl.y > q.nl.y && q.fr.y > q.nr.y, 'far edge is further down the image');
  assert.equal(Keyboard.isSpanPose(l, r, 1280, 720), 'ok');
});

test('isSpanPose rejects hands at different heights, curled, or too close', () => {
  const l = { pts: handPts(300, 300, 70) };
  assert.equal(Keyboard.isSpanPose(l, { pts: handPts(950, 450, 70, { mirror: true }) }, 1280, 720), 'level');
  const curled = { pts: handPts(950, 300, 70, { mirror: true, dy: [-60, -80, -80, -80, -70] }) };
  assert.equal(Keyboard.isSpanPose(l, curled, 1280, 720), 'flat');
  assert.equal(Keyboard.isSpanPose(l, { pts: handPts(420, 300, 70, { mirror: true }) }, 1280, 720), 'apart');
});

test('fit() rescales on resolution change and invalidates on aspect change', () => {
  const kb = trapezoid();
  const p = kb.point(0.3, 0.5);
  assert.equal(kb.fit(1280, 720), 'ok');
  assert.equal(kb.fit(640, 360), 'rescaled');
  assert.equal(kb.keyAt(p.x / 2, p.y / 2), 2);
  assert.equal(kb.fit(480, 640), 'invalid');
  assert.equal(kb.quad, null);
});

test('load() survives corrupt storage', () => {
  const kb = new Keyboard();
  kb.load({ quad: { nl: { x: 'a' } }, scale: 'nope', octave: 99 });
  assert.equal(kb.quad, null); assert.equal(kb.scale, 'major'); assert.equal(kb.octave, 4);
  kb.load({ quad: placedKeyboard().quad });   // quad without frame → dropped
  assert.equal(kb.quad, null);
  const good = placedKeyboard(); kb.load(JSON.parse(JSON.stringify(good.toJSON())));
  assert.deepEqual(kb.quad, good.quad);
});

test('scales and note names', () => {
  const kb = new Keyboard();
  assert.equal(kb.label(0), 'C4'); assert.equal(kb.label(7), 'C5'); assert.equal(kb.midi(0), 60);
  kb.scale = 'minor'; assert.equal(kb.label(0), 'A3');
  for (const s of Object.values(SCALES)) assert.equal(s.steps.length, 8);
  assert.equal(noteName(61), 'C♯4'); assert.equal(noteName(21), 'A0');
});
