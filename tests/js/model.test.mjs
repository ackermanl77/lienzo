// Pruebas de web/js/model.js con el ejecutor de Node: node --test tests/js
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  History, MAX_DRAW_POINTS, bounds, corners, elementAt, hitTest, makeDrawing, makeImage, makeShape, makeText, resizeBox, resizeDesign, rotate,
  rotationFromPointer, snap, toLocal, unionBounds, wrapText,
} from "../../web/js/model.js";

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
const box = (extra = {}) => ({ left: 100, top: 100, width: 200, height: 100, rotation: 0, ...extra });

test("rotate and toLocal are inverses", () => {
  const el = box({ rotation: 30 });
  const p = { x: 180, y: 130 };
  const local = toLocal(el, p);
  const back = rotate({ x: local.x + el.left, y: local.y + el.top }, { x: 200, y: 150 }, 30);
  close(back.x, p.x);
  close(back.y, p.y);
});

test("bounds of a rotated element contain all its corners", () => {
  const el = box({ rotation: 45 });
  const b = bounds(el);
  for (const c of corners(el)) {
    assert.ok(c.x >= b.left - 1e-9 && c.x <= b.left + b.width + 1e-9);
    assert.ok(c.y >= b.top - 1e-9 && c.y <= b.top + b.height + 1e-9);
  }
  close(b.width, b.height); // 200x100 at 45° -> square bounds
});

test("hit testing respects rotation and picks the top-most element", () => {
  const el = box({ rotation: 90 }); // now 100 wide, 200 tall around (200,150)
  assert.ok(hitTest(el, { x: 200, y: 60 }));
  assert.ok(!hitTest(el, { x: 120, y: 150 }));
  const page = { elements: [box({ id: "a" }), box({ id: "b", left: 150 })] };
  assert.equal(elementAt(page, { x: 200, y: 150 }).id, "b");
  assert.equal(elementAt(page, { x: 110, y: 150 }).id, "a");
  assert.equal(elementAt(page, { x: 10, y: 10 }), null);
});

test("resizing keeps the opposite corner fixed, also when rotated", () => {
  for (const rotation of [0, 37]) {
    const start = box({ rotation });
    const anchorBefore = corners(start)[0]; // nw stays put when dragging se
    const target = rotate({ x: 400, y: 260 }, { x: 200, y: 150 }, rotation);
    const result = resizeBox(start, "se", target);
    const anchorAfter = corners({ ...start, ...result })[0];
    close(anchorAfter.x, anchorBefore.x, 1e-6);
    close(anchorAfter.y, anchorBefore.y, 1e-6);
  }
  const side = resizeBox(box(), "e", { x: 350, y: 999 });
  assert.deepEqual([side.left, side.top, side.width, side.height], [100, 100, 250, 100]);
  const aspect = resizeBox(box(), "se", { x: 500, y: 160 }, true);
  close(aspect.width / aspect.height, 2);
  const tiny = resizeBox(box(), "w", { x: 9999, y: 0 }, false, 4);
  assert.equal(tiny.width, 4);
});

test("rotation handle snaps near multiples of 45 degrees", () => {
  const el = box();
  assert.equal(rotationFromPointer(el, { x: 200, y: 0 }), 0);
  assert.equal(rotationFromPointer(el, { x: 400, y: 151 }), 90);
  const free = rotationFromPointer(el, { x: 400, y: 151 }, true);
  assert.notEqual(free, 90);
});

test("smart guides snap edges and centres to the page and other elements", () => {
  const page = { width: 1000, height: 800 };
  const moved = { left: 403, top: 50, width: 200, height: 100 };
  const r = snap(moved, [], page, 5);
  assert.equal(r.dx, -3); // centre 503 -> page centre 500
  assert.deepEqual(r.guides, [{ axis: "x", pos: 500 }]);
  const other = { left: 700, top: 300, width: 100, height: 100 };
  const r2 = snap({ left: 650, top: 296, width: 50, height: 50 }, [other], page, 5);
  assert.equal(r2.dy, 4);
  assert.equal(snap({ left: 120, top: 120, width: 10, height: 10 }, [], page, 5).guides.length, 0);
});

test("text wraps by words, keeps line breaks and splits long words", () => {
  const measure = (s) => s.length * 10;
  assert.deepEqual(wrapText("hola mundo cruel", 100, measure), ["hola mundo", "cruel"]);
  assert.deepEqual(wrapText("uno\ndos", 100, measure), ["uno", "dos"]);
  assert.deepEqual(wrapText("abcdefghijklmnop", 50, measure), ["abcde", "fghij", "klmno", "p"]);
  assert.deepEqual(wrapText("", 100, measure), [""]);
  assert.deepEqual(wrapText("a supercalifragilistico b", 60, measure), ["a", "superc", "alifra", "gilist", "ico b"]);
});

test("new elements are centred on the page", () => {
  const design = { width: 1000, height: 500 };
  for (const el of [makeText("heading", design), makeShape("star", design), makeShape("line", design)]) {
    close(el.left + el.width / 2, 500, 1e-9);
    close(el.top + el.height / 2, 250, 1e-9);
  }
  const img = makeImage({ id: "0123456789abcdef", width: 4000, height: 2000 }, design);
  close(img.width / img.height, 2);
  assert.ok(img.width <= 600 && img.height <= 300);
  assert.equal(img.fill.image, "0123456789abcdef");
  assert.equal(img.type, "rect");
});

test("union bounds and history", () => {
  const u = unionBounds([box(), box({ left: 400, top: 50 })]);
  assert.deepEqual(u, { left: 100, top: 50, width: 500, height: 150 });
  assert.equal(unionBounds([]), null);
  const h = new History(2);
  h.record("a"); h.record("b"); h.record("c");
  assert.equal(h.past.length, 2);
  assert.equal(h.undo("d"), "c");
  assert.equal(h.redo("c"), "d");
  h.record("x");
  assert.equal(h.canRedo, false);
});

import {
  animState, animationsEnd, cellAt, expandGroups, makeTable, rotateElements, scaleElements, tableInsertCol,
  tableInsertRow, tableLayout, tableRemoveCol, tableRemoveRow,
} from "../../web/js/model.js";

test("entrance animations start hidden or displaced and end at rest", () => {
  const el = { width: 100, height: 100, animation: { type: "rise", delay: 1, duration: 2 } };
  assert.equal(animState(el, 0).alpha, 0);
  assert.ok(animState(el, 2).dy > 0 && animState(el, 2).alpha > 0);
  assert.deepEqual(animState(el, 3.5), { alpha: 1, dx: 0, dy: 0, scale: 1, rotate: 0, text: 1 });
  assert.deepEqual(animState(el, null), animState({}, 5));
  const typing = animState({ type: "text", animation: { type: "typewriter", delay: 0, duration: 4 } }, 1);
  assert.equal(typing.text, 0.25);
  for (const type of ["fade", "slide_left", "slide_right", "pop", "zoom_out", "drop", "spin"]) {
    const end = animState({ width: 10, height: 10, animation: { type, delay: 0, duration: 1 } }, 1);
    close(end.alpha, 1); close(end.scale, 1); close(end.dx, 0); close(end.dy, 0, 1e-6); close(end.rotate, 0);
  }
  assert.equal(animationsEnd({ elements: [el, { animation: { type: "fade", delay: 0.5, duration: 0.8 } }, {}] }), 3);
});

test("tables lay out rows to their text and support row/column edits", () => {
  const t = makeTable({ width: 1000, height: 1000 }, 3, 2);
  t.cells[1][0] = "una línea muy larga que tiene que partirse en varias";
  const L = tableLayout(t, (s) => s.length * 10);
  assert.ok(L.rowH[1] > L.rowH[2]);
  close(L.height, L.rowH.reduce((a, b) => a + b, 0));
  assert.deepEqual(cellAt(L, { x: t.width - 1, y: L.rowY[2] + 1 }), { r: 2, c: 1 });
  assert.equal(cellAt(L, { x: -5, y: 0 }), null);
  tableInsertRow(t, 1); tableInsertCol(t, 0);
  assert.deepEqual([t.rows, t.cols, t.cells[0].length], [4, 3, 3]);
  close(t.colWidths.reduce((a, b) => a + b, 0), 1);
  tableRemoveRow(t, 0); tableRemoveCol(t, 2);
  assert.deepEqual([t.rows, t.cols], [3, 2]);
  const one = makeTable({ width: 100, height: 100 }, 1, 1);
  tableRemoveRow(one, 0); tableRemoveCol(one, 0);
  assert.deepEqual([one.rows, one.cols], [1, 1]);
});

test("groups expand selections and transform as one", () => {
  const page = { elements: [{ id: "a", group: "g" }, { id: "b", group: "g" }, { id: "c" }] };
  assert.deepEqual(expandGroups(page, ["a"]), ["a", "b"]);
  assert.deepEqual(expandGroups(page, ["c"]), ["c"]);
  const starts = [{ id: "a", left: 0, top: 0, width: 100, height: 100, fontSize: 20, rotation: 0 },
    { id: "b", left: 100, top: 100, width: 100, height: 100, rotation: 170 }];
  const [a, b] = scaleElements(starts, { left: 0, top: 0, width: 200, height: 200 }, { left: 0, top: 0, width: 400, height: 400 });
  assert.deepEqual([a.left, a.top, a.width, a.fontSize], [0, 0, 200, 40]);
  assert.deepEqual([b.left, b.top, b.width], [200, 200, 200]);
  const [ra, rb] = rotateElements(starts, { x: 100, y: 100 }, 20);
  assert.equal(ra.rotation, 20);
  assert.equal(rb.rotation, -170);
  close(ra.left + 50, 100 + Math.cos(((225 + 20) * Math.PI) / 180) * Math.SQRT2 * 50, 1e-6);
});

test("Cambiar tamaño: proportional positions, uniform scale, full-page elements still cover (UI3)", () => {
  const design = {
    id: "d", title: "Post", width: 1000, height: 1000,
    pages: [{ id: "p", background: { color: "#fff" }, elements: [
      { id: "bg", type: "rect", left: 0, top: 0, width: 1000, height: 1000, rotation: 0, radius: 0 },
      { id: "t", type: "text", left: 400, top: 100, width: 200, height: 60, rotation: 0, fontSize: 50 },
      { id: "s", type: "rect", left: 850, top: 850, width: 100, height: 100, rotation: 10, stroke: { color: "#000", width: 4 } },
    ] }],
  };
  const story = resizeDesign(design, 1080, 1920);
  assert.equal(story.width, 1080);
  assert.equal(story.height, 1920);
  assert.equal(design.width, 1000); // the original is untouched
  const [bg, text, shape] = story.pages[0].elements;
  // The background scales by the larger factor (1.92) and still covers the taller page.
  assert.ok(bg.left <= 0 && bg.top <= 0 && bg.left + bg.width >= 1080 && bg.top + bg.height >= 1920);
  // Everything else by the smaller (1.08), centred where it was in proportion.
  close(text.fontSize, 54);
  close(text.left + text.width / 2, 500 * 1.08);
  close(text.top + text.height / 2, 130 * 1.92);
  close(shape.width, 108);
  close(shape.stroke.width, 4 * 1.08);
  assert.equal(shape.rotation, 10);
  assert.ok(shape.left + shape.width <= 1080 && shape.top + shape.height <= 1920); // nothing pushed off the page
  assert.equal(text.type, "text"); // every other field kept
});

test("a freehand stroke becomes a draw element whose points are fractions of its box (UI4)", () => {
  const points = [{ x: 100, y: 100 }, { x: 100.1, y: 100 }, { x: 200, y: 150 }, { x: 300, y: 100 }];
  const el = makeDrawing(points, "#ff0000", 10);
  assert.equal(el.type, "draw");
  assert.deepEqual(el.stroke, { color: "#ff0000", width: 10 });
  // The box wraps the points plus half the thickness.
  close(el.left, 95);
  close(el.top, 95);
  close(el.width, 210);
  close(el.height, 60);
  assert.equal(el.points.length, 3); // the near-repeat was dropped
  assert.ok(el.points.every(([x, y]) => x >= 0 && x <= 1 && y >= 0 && y <= 1));
  close(el.points[1][0] * el.width + el.left, 200);
  close(el.points[1][1] * el.height + el.top, 150);
  assert.equal(makeDrawing([{ x: 5, y: 5 }, { x: 5.1, y: 5 }], "#000000", 8), null); // a click, not a stroke
  const long = Array.from({ length: 5000 }, (_, i) => ({ x: i, y: Math.sin(i / 50) * 100 }));
  assert.ok(makeDrawing(long, "#000000", 2).points.length <= MAX_DRAW_POINTS + 1);
});
