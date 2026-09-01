import assert from "node:assert/strict";
import test from "node:test";

import { directorStyle, listDirectorStyles } from "./director-library.js";

test("director library exposes all unique local directors", () => {
  const directors = listDirectorStyles();
  assert.equal(directors.length, 60);
  assert.equal(new Set(directors.map((item) => item.name)).size, 60);
  assert.equal(directors.filter((item) => item.completeness === "完整").length, 45);
  assert.equal(directors.filter((item) => item.completeness === "部分").length, 15);
});

test("director lookup returns observable parameters and rejects unknown names", () => {
  const director = directorStyle("克里斯托弗·诺兰");
  assert.ok(director);
  assert.ok(director.parameters.length >= 1 && director.parameters.length <= 4);
  assert.equal(directorStyle("不存在的导演"), null);
});
